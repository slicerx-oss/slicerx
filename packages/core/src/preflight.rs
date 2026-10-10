// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Safety preflight. Two passes, both run by [`crate::api`] so every entry
//! point (CLI, FFI, WASM, cloud, MCP) gets them:
//!
//! - [`clamp_config`] runs before slicing. It pulls layer height, line width,
//!   temperatures and speeds inside the nozzle and machine limits and reports
//!   each change as a warning, and it rejects values no printer can use.
//! - [`check_toolpaths`] runs on the sliced paths. Every extrusion move must
//!   stay on the real bed polygon and outside every `bed_exclude_area`, and
//!   every layer (with its z-hop) must fit under the printable height. Any
//!   miss is an error that blocks the file.
//!
//! Errors block; warnings are shown and need a person's yes.

use crate::config::PrintConfig;
use crate::fm::Fm;
use crate::gcode_lint::{Limits, Severity};
use crate::geom::SCALE;
use crate::output::{Feature, SliceOutput};
use serde_json::Value;

/// One finding of the preflight.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Issue {
    pub code: &'static str,
    pub severity: Severity,
    pub message: String,
    /// First layer where it happens, 0-based, for toolpath findings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<u32>,
}

impl Issue {
    fn new(code: &'static str, severity: Severity, message: String) -> Self {
        Self {
            code,
            severity,
            message,
            layer: None,
        }
    }
}

/// True when any issue blocks.
pub fn blocks(issues: &[Issue]) -> bool {
    issues.iter().any(|i| i.severity == Severity::Error)
}

/// Text of the blocking issues, for an error message.
pub fn blocking_text(issues: &[Issue]) -> String {
    issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| i.message.as_str())
        .collect::<Vec<_>>()
        .join("; ")
}

/// Keys a file may never set: `post_process` runs programs on this machine, and
/// the printer host credentials are secrets that belong in the keychain, not in a
/// profile, project, export or log.
pub fn is_never_imported(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k == "post_process"
        || k.starts_with("printhost_")
            && ["user", "password", "apikey", "api_key", "authorization", "cafile"]
                .iter()
                .any(|s| k.contains(s))
        || [
            "password",
            "apikey",
            "api_key",
            "access_code",
            "secret",
            "token",
            "bearer",
        ]
        .iter()
        .any(|s| k.contains(s))
}

/// Lints rendered custom G-code with the request's limits and trust. Errors block.
pub fn vet_custom(
    section: crate::gcode_lint::Section,
    text: &str,
    cfg: &PrintConfig,
) -> crate::error::Result<()> {
    let trust = if cfg.untrusted_gcode {
        crate::gcode_lint::Trust::Untrusted
    } else {
        crate::gcode_lint::Trust::Trusted
    };
    vet_text(section, text, trust, &cfg.limits)
}

/// Lints rendered custom G-code as `trust` says. Errors block.
pub(crate) fn vet_text(
    section: crate::gcode_lint::Section,
    text: &str,
    trust: crate::gcode_lint::Trust,
    limits: &crate::gcode_lint::Limits,
) -> crate::error::Result<()> {
    let report = crate::gcode_lint::lint(text, section, trust, limits);
    if report.ok() {
        Ok(())
    } else {
        let errs: Vec<String> = report
            .errors()
            .map(|f| format!("line {}: {} ({})", f.line, f.message, f.code))
            .collect();
        Err(crate::error::Error::Blocked(format!(
            "custom G-code: {}",
            errs.join("; ")
        )))
    }
}

/// Tolerance for a point on the edge of the bed or a zone, mm.
pub(crate) const EDGE_TOL_MM: f64 = 0.05;

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Array(a) => a.first().and_then(number),
        _ => None,
    }
}

/// A point as `"12x34"`, `"12,34"` or `[12, 34]`.
pub(crate) fn point(v: &Value) -> Option<[f64; 2]> {
    match v {
        Value::String(s) => {
            let (a, b) = s.split_once('x').or_else(|| s.split_once(','))?;
            Some([a.trim().parse().ok()?, b.trim().parse().ok()?])
        }
        Value::Array(a) if a.len() == 2 => Some([number(a.first()?)?, number(a.get(1)?)?]),
        _ => None,
    }
}

/// The exclusion zones of `bed_exclude_area`: several from a list of lists, or from a flat list of points
/// one per four points, as Orca reads it (`PartPlate::calc_bounding_boxes` makes a box of each four; the
/// Qidi X-Plus 4 lists two corner strips joined along the bed's edges that way). A shorter tail is dropped,
/// as Orca drops it, and so are zones with fewer than 3 points.
pub fn exclude_zones(cfg: &PrintConfig) -> Vec<Vec<[f64; 2]>> {
    let Some(Value::Array(items)) = cfg.raw.get("bed_exclude_area") else {
        return Vec::new();
    };
    let nested = items
        .iter()
        .all(|i| matches!(i, Value::Array(a) if a.len() != 2 || a.first().is_some_and(Value::is_array)));
    let zones: Vec<Vec<[f64; 2]>> = if nested && !items.is_empty() {
        items
            .iter()
            .filter_map(|z| match z {
                Value::Array(pts) => Some(pts.iter().filter_map(point).collect()),
                _ => None,
            })
            .collect()
    } else {
        let pts: Vec<[f64; 2]> = items.iter().filter_map(point).collect();
        if pts.len() <= 4 {
            vec![pts]
        } else {
            // A group that is only a line (the X-Plus 4's join along the right edge) excludes nothing.
            let area = |q: &[[f64; 2]; 4]| {
                let twice: f64 = q
                    .iter()
                    .zip(q.iter().cycle().skip(1))
                    .map(|(a, b)| a[0] * b[1] - b[0] * a[1])
                    .sum();
                twice.abs() / 2.0
            };
            pts.as_chunks::<4>()
                .0
                .iter()
                .filter(|q| area(q) > 0.01)
                .map(|q| q.to_vec())
                .collect()
        }
    };
    zones.into_iter().filter(|z| z.len() >= 3).collect()
}

/// Point inside or on the border (within `tol`) of a polygon.
fn near_or_inside(poly: &[[f64; 2]], x: f64, y: f64, tol: f64) -> bool {
    let n = poly.len();
    let mut inside = false;
    for i in 0..n {
        let (Some(a), Some(b)) = (poly.get(i), poly.get((i + 1) % n)) else {
            continue;
        };
        if dist_to_segment(x, y, a, b) <= tol {
            return true;
        }
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
    }
    inside
}

/// A point of the segment `a`-`b` that lies more than `tol` inside `poly` (with `inside`) or more than `tol` outside
/// it (without), or None. The segment is cut where it crosses the polygon's edges and each piece is tried at its
/// quarter points and middle (and at the segment's own ends), so a move whose ends both lie clear can still be
/// caught running through the polygon. A segment that only runs along or touches an edge, within `tol`, is clear.
pub(crate) fn segment_reaches(
    poly: &[[f64; 2]],
    a: [f64; 2],
    b: [f64; 2],
    inside: bool,
    tol: f64,
) -> Option<[f64; 2]> {
    let n = poly.len();
    if n < 3 {
        return None;
    }
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let mut cuts = vec![0.0, 1.0];
    for i in 0..n {
        let (Some(c), Some(d)) = (poly.get(i), poly.get((i + 1) % n)) else {
            continue;
        };
        let (ex, ey) = (d[0] - c[0], d[1] - c[1]);
        let den = dx * ey - dy * ex;
        if den.abs() < 1e-12 {
            continue;
        }
        let t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
        let u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
        if t > 0.0 && t < 1.0 && (-1e-9..=1.0 + 1e-9).contains(&u) {
            cuts.push(t);
        }
    }
    crate::sorting::sort_by(&mut cuts, f64::total_cmp);
    let clear = |t: f64| -> Option<[f64; 2]> {
        let p = [a[0] + t * dx, a[1] + t * dy];
        let depth = (0..n)
            .filter_map(|i| Some(dist_to_segment(p[0], p[1], poly.get(i)?, poly.get((i + 1) % n)?)))
            .fold(f64::INFINITY, f64::min);
        (depth > tol && near_or_inside(poly, p[0], p[1], 0.0) == inside).then_some(p)
    };
    if let Some(p) = clear(0.0).or_else(|| clear(1.0)) {
        return Some(p);
    }
    cuts.windows(2).find_map(|w| {
        let [t0, t1] = w else { return None };
        [0.5, 0.25, 0.75]
            .into_iter()
            .find_map(|f| clear(t0 + (t1 - t0) * f))
    })
}

/// Where a travel from `a` to `b` meets the zone `poly`, or None: a travel that runs more than `tol` inside it, or
/// one that passes closer to it than `clearance` (the nozzle's width) and closer than either of its own ends. A travel
/// leaving a print path that runs along the zone's edge starts that close by right, so only coming closer on the way
/// counts.
pub(crate) fn travel_meets(
    poly: &[[f64; 2]],
    a: [f64; 2],
    b: [f64; 2],
    clearance: f64,
    tol: f64,
) -> Option<[f64; 2]> {
    if let Some(p) = segment_reaches(poly, a, b, true, tol) {
        return Some(p);
    }
    let n = poly.len();
    let edge_dist = |p: [f64; 2]| {
        (0..n)
            .filter_map(|i| Some(dist_to_segment(p[0], p[1], poly.get(i)?, poly.get((i + 1) % n)?)))
            .fold(f64::INFINITY, f64::min)
    };
    // The travel's closest approach to the zone's edge: at a corner of the zone, or at an end of the travel.
    let mut best: Option<(f64, [f64; 2])> = None;
    let mut consider = |d: f64, p: [f64; 2]| {
        if best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, p));
        }
    };
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    for c in poly {
        let t = if len2 == 0.0 {
            0.0
        } else {
            (((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
        };
        let p = [a[0] + t * dx, a[1] + t * dy];
        consider(dist_to_segment(c[0], c[1], &a, &b), p);
    }
    for p in [a, b] {
        consider(edge_dist(p), p);
    }
    // Two segments that do not cross are closest at an end of one of them; one that crosses an edge enters the
    // zone, which the first test found unless it only grazes a corner, within `tol`.
    let (d, p) = best?;
    let ends = edge_dist(a).min(edge_dist(b));
    (d < clearance && d + tol < ends).then_some(p)
}

fn dist_to_segment(x: f64, y: f64, a: &[f64; 2], b: &[f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((x - a[0]) * dx + (y - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    ((x - (a[0] + t * dx)).m_powi(2) + (y - (a[1] + t * dy)).m_powi(2)).sqrt()
}

fn bounds(poly: &[[f64; 2]]) -> [f64; 4] {
    let mut r = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for p in poly {
        r[0] = r[0].min(p[0]);
        r[1] = r[1].min(p[1]);
        r[2] = r[2].max(p[0]);
        r[3] = r[3].max(p[1]);
    }
    r
}

fn is_axis_rect(poly: &[[f64; 2]]) -> bool {
    poly.len() == 4
        && (0..4).all(|i| {
            let (Some(a), Some(b)) = (poly.get(i), poly.get((i + 1) % 4)) else {
                return false;
            };
            (a[0] - b[0]).abs() < 1e-9 || (a[1] - b[1]).abs() < 1e-9
        })
}

/// Bed shape and zones of one settings index: (index, polygon, bounds, is an axis rectangle, zones).
type BedCache = (u16, Vec<[f64; 2]>, [f64; 4], bool, Vec<Zone>);

struct Zone {
    poly: Vec<[f64; 2]>,
    bbox: [f64; 4],
}

/// Checks the toolpaths of `out` against the bed polygon, exclusion zones and
/// printable height of each layer's settings.
pub fn check_toolpaths(out: &SliceOutput, base: &PrintConfig) -> Vec<Issue> {
    let mut outside = Count::default();
    let mut outside_feature = None;
    let mut in_zone = Count::default();
    let mut too_tall = Count::default();
    // On a printer with two extruders, each filament's paths stay inside its extruder's reach
    // (`extruder_printable_area`), as Orca's GCodeProcessor::check_multi_extruder_gcode_valid requires.
    let reach = out.filament_map.as_ref().map(|m| {
        let ext = crate::nozzles::extruders(base);
        (m, crate::nozzles::reach_boxes(base, ext))
    });
    let mut unreachable = Count::default();
    let mut unreachable_by = (0u8, 0usize, Feature::OuterWall);
    let mut bed_cache: Vec<BedCache> = Vec::new();
    for l in &out.layers {
        if !bed_cache.iter().any(|(k, ..)| *k == l.cfg) {
            let c = out.config_at(base, l.cfg);
            let poly = c.printable_area.clone();
            let bb = bounds(&poly);
            let rect = is_axis_rect(&poly);
            let zones = exclude_zones(c)
                .into_iter()
                .map(|p| {
                    let bbox = bounds(&p);
                    Zone { poly: p, bbox }
                })
                .collect();
            bed_cache.push((l.cfg, poly, bb, rect, zones));
        }
        let Some((_, poly, bb, rect, zones)) = bed_cache.iter().find(|(k, ..)| *k == l.cfg) else {
            continue;
        };
        let c = out.config_at(base, l.cfg);
        let top = f64::from(l.z) + if c.z_hop > 0.0 { c.z_hop } else { 0.0 };
        if top > c.printable_height + 1e-3 {
            too_tall.hit(l.index, 0.0, f64::from(l.z), top);
        }
        for p in &l.paths {
            let pts = l.path_points(p);
            for (i, pt) in pts.iter().enumerate() {
                let (x, y) = (f64::from(pt.x) / SCALE, f64::from(pt.y) / SCALE);
                // The move from the point before: on a bed or zone that is not convex, or a zone the move runs
                // through, its ends alone do not tell.
                let from = i
                    .checked_sub(1)
                    .and_then(|k| pts.get(k))
                    .map_or([x, y], |q| [f64::from(q.x) / SCALE, f64::from(q.y) / SCALE]);
                let in_bbox = x >= bb[0] - EDGE_TOL_MM
                    && x <= bb[2] + EDGE_TOL_MM
                    && y >= bb[1] - EDGE_TOL_MM
                    && y <= bb[3] + EDGE_TOL_MM;
                if !in_bbox || (!*rect && !near_or_inside(poly, x, y, EDGE_TOL_MM)) {
                    if outside.n == 0 {
                        outside_feature = Some(p.feature);
                    }
                    outside.hit(l.index, x, y, 0.0);
                    continue;
                }
                if !*rect && let Some(q) = segment_reaches(poly, from, [x, y], false, EDGE_TOL_MM) {
                    if outside.n == 0 {
                        outside_feature = Some(p.feature);
                    }
                    outside.hit(l.index, q[0], q[1], 0.0);
                    continue;
                }
                if let Some((m, boxes)) = &reach {
                    let e = m.extruder_of(p.tool);
                    if let Some(Some(r)) = boxes.get(e)
                        && (x < r[0] - EDGE_TOL_MM
                            || x > r[2] + EDGE_TOL_MM
                            || y < r[1] - EDGE_TOL_MM
                            || y > r[3] + EDGE_TOL_MM)
                    {
                        if unreachable.n == 0 {
                            unreachable_by = (p.tool, e, p.feature);
                        }
                        unreachable.hit(l.index, x, y, 0.0);
                    }
                }
                for z in zones {
                    // Only moves that run clearly inside a zone: touching or running along its edge is allowed.
                    let reach = [from[0].min(x), from[1].min(y), from[0].max(x), from[1].max(y)];
                    if reach[2] > z.bbox[0] + EDGE_TOL_MM
                        && reach[0] < z.bbox[2] - EDGE_TOL_MM
                        && reach[3] > z.bbox[1] + EDGE_TOL_MM
                        && reach[1] < z.bbox[3] - EDGE_TOL_MM
                        && let Some(q) = segment_reaches(&z.poly, from, [x, y], true, EDGE_TOL_MM)
                    {
                        in_zone.hit(l.index, q[0], q[1], 0.0);
                    }
                }
            }
        }
    }
    let mut issues = Vec::new();
    if outside.n > 0 {
        let mut i = Issue::new(
            "outside_bed",
            Severity::Error,
            format!(
                "{} toolpath points lie outside the printable area, first at layer {} (X{:.1} Y{:.1}, {})",
                outside.n,
                outside.layer + 1,
                outside.x,
                outside.y,
                outside_feature
                    .map_or("toolpath", Feature::gcode_label)
                    .to_lowercase()
            ),
        );
        i.layer = Some(outside.layer);
        issues.push(i);
    }
    if unreachable.n > 0 {
        let (slot, e, feature) = unreachable_by;
        let mut i = Issue::new(
            "outside_extruder_reach",
            Severity::Error,
            format!(
                "{} toolpath points of filament {} lie outside the reach of extruder {}, first at layer {} (X{:.1} Y{:.1}, {}); map the filament to the other extruder or move the part",
                unreachable.n,
                slot,
                e + 1,
                unreachable.layer + 1,
                unreachable.x,
                unreachable.y,
                feature.gcode_label().to_lowercase()
            ),
        );
        i.layer = Some(unreachable.layer);
        issues.push(i);
    }
    if in_zone.n > 0 {
        let mut i = Issue::new(
            "in_exclusion_zone",
            Severity::Error,
            format!(
                "{} toolpath moves enter an excluded bed area, first at layer {} (X{:.1} Y{:.1})",
                in_zone.n,
                in_zone.layer + 1,
                in_zone.x,
                in_zone.y
            ),
        );
        i.layer = Some(in_zone.layer);
        issues.push(i);
    }
    if too_tall.n > 0 {
        let mut i = Issue::new(
            "over_height",
            Severity::Error,
            format!(
                "{} layers reach above the printable height (with z-hop), first at layer {} (Z{:.2} mm)",
                too_tall.n,
                too_tall.layer + 1,
                too_tall.z
            ),
        );
        i.layer = Some(too_tall.layer);
        issues.push(i);
    }
    issues
}

#[derive(Default)]
struct Count {
    n: u64,
    layer: u32,
    x: f64,
    y: f64,
    z: f64,
}

impl Count {
    fn hit(&mut self, layer: u32, x: f64, y: f64, z: f64) {
        if self.n == 0 {
            self.layer = layer;
            self.x = x;
            self.y = y;
            self.z = z;
        }
        self.n += 1;
    }
}

// --------------------------------------------------------------------- config

/// Layer height as a share of the nozzle diameter: the most a nozzle can lay down.
const MAX_LAYER_OF_NOZZLE: f64 = 1.0;
/// Least layer height any slicer offers, mm.
const MIN_LAYER_MM: f64 = 0.04;
/// Line width limits as a share of the nozzle diameter.
const MIN_WIDTH_OF_NOZZLE: f64 = 0.1;
const MAX_WIDTH_OF_NOZZLE: f64 = 2.5;

fn raw_number(cfg: &PrintConfig, key: &str) -> Option<f64> {
    cfg.raw.get(key).and_then(number)
}

/// The smallest positive of the first entry of a raw list, or the scalar.
fn machine_limit(cfg: &PrintConfig, key: &str) -> Option<f64> {
    raw_number(cfg, key).filter(|v| *v > 0.0)
}

/// Pulls settings inside the limits and returns what changed (warnings) and
/// what cannot be used at all (errors, the config is then left as it was for those keys).
pub fn clamp_config(cfg: &mut PrintConfig, limits: &Limits) -> Vec<Issue> {
    let mut issues = Vec::new();
    let warn = |code: &'static str, message: String| Issue::new(code, Severity::Warning, message);
    let error = |code: &'static str, message: String| Issue::new(code, Severity::Error, message);

    if !cfg.nozzle_diameter.is_finite() || cfg.nozzle_diameter <= 0.0 {
        issues.push(error(
            "nozzle_diameter",
            "the nozzle diameter must be above 0 mm".to_owned(),
        ));
        return issues;
    }
    if !cfg.filament_diameter.is_finite() || cfg.filament_diameter <= 0.0 {
        issues.push(error(
            "filament_diameter",
            "the filament diameter must be above 0 mm".to_owned(),
        ));
        return issues;
    }
    let nozzle = cfg.nozzle_diameter;

    // Layer height.
    let min_h = machine_limit(cfg, "min_layer_height")
        .unwrap_or(MIN_LAYER_MM)
        .max(MIN_LAYER_MM);
    let max_h = machine_limit(cfg, "max_layer_height")
        .unwrap_or(nozzle * MAX_LAYER_OF_NOZZLE)
        .min(nozzle * MAX_LAYER_OF_NOZZLE);
    if !cfg.layer_height.is_finite() || cfg.layer_height <= 0.0 {
        issues.push(error(
            "layer_height",
            "the layer height must be above 0 mm".to_owned(),
        ));
    } else if cfg.layer_height > max_h + 1e-9 {
        issues.push(warn(
            "layer_height_clamped",
            format!(
                "layer height {} mm is above the {max_h:.2} mm this nozzle can print; using {max_h:.2} mm",
                cfg.layer_height
            ),
        ));
        cfg.layer_height = max_h;
    } else if cfg.layer_height < min_h - 1e-9 {
        issues.push(warn(
            "layer_height_clamped",
            format!(
                "layer height {} mm is below the {min_h:.2} mm minimum; using {min_h:.2} mm",
                cfg.layer_height
            ),
        ));
        cfg.layer_height = min_h;
    }
    if !cfg.initial_layer_print_height.is_finite() || cfg.initial_layer_print_height <= 0.0 {
        issues.push(error(
            "initial_layer_print_height",
            "the first layer height must be above 0 mm".to_owned(),
        ));
    } else if cfg.initial_layer_print_height > nozzle * MAX_LAYER_OF_NOZZLE + 1e-9 {
        let v = nozzle * MAX_LAYER_OF_NOZZLE;
        issues.push(warn(
            "first_layer_clamped",
            format!(
                "first layer height {} mm is above the nozzle diameter; using {v:.2} mm",
                cfg.initial_layer_print_height
            ),
        ));
        cfg.initial_layer_print_height = v;
    }

    // Line width.
    let (lo_w, hi_w) = (nozzle * MIN_WIDTH_OF_NOZZLE, nozzle * MAX_WIDTH_OF_NOZZLE);
    if !cfg.line_width.is_finite() || cfg.line_width <= 0.0 {
        issues.push(error(
            "line_width",
            "the line width must be above 0 mm".to_owned(),
        ));
    } else if cfg.line_width > hi_w + 1e-9 || cfg.line_width < lo_w - 1e-9 {
        let v = cfg.line_width.clamp(lo_w, hi_w);
        issues.push(warn(
            "line_width_clamped",
            format!(
                "line width {} mm is outside {lo_w:.2} to {hi_w:.2} mm for this nozzle; using {v:.2} mm",
                cfg.line_width
            ),
        ));
        cfg.line_width = v;
    }

    // Temperatures.
    issues.extend(plate_temps(cfg));
    issues.extend(clamp_temperatures(cfg, limits));

    issues.extend(check_materials(cfg, limits));

    // Speeds against the machine's axis limits.
    let axis = [
        machine_limit(cfg, "machine_max_speed_x"),
        machine_limit(cfg, "machine_max_speed_y"),
    ];
    if let Some(cap) = axis.iter().flatten().copied().reduce(f64::min) {
        for (name, v) in [
            ("outer_wall_speed", &mut cfg.outer_wall_speed),
            ("inner_wall_speed", &mut cfg.inner_wall_speed),
            ("sparse_infill_speed", &mut cfg.sparse_infill_speed),
            (
                "internal_solid_infill_speed",
                &mut cfg.internal_solid_infill_speed,
            ),
            ("top_surface_speed", &mut cfg.top_surface_speed),
            ("initial_layer_speed", &mut cfg.initial_layer_speed),
            ("initial_layer_infill_speed", &mut cfg.initial_layer_infill_speed),
        ] {
            if *v > cap {
                issues.push(warn(
                    "speed_clamped",
                    format!("{name} {v} mm/s is above the machine limit of {cap} mm/s; using {cap} mm/s"),
                ));
                *v = cap;
            }
        }
        // Travel is left as the profile asks: Orca writes it as it is (the A1's 700 mm/s against its 500 mm/s
        // axes), the firmware caps each axis, and the time estimate caps it the same way.
    }
    issues
}

/// Holds the nozzle and bed temperatures to the machine's limits. Every config the G-code is
/// written from goes through it: the plate's, and each object's, modifier's and height range's
/// settings on top of it.
pub(crate) fn hold_temperatures(cfg: &mut PrintConfig) -> Vec<Issue> {
    let limits = cfg.limits;
    clamp_temperatures(cfg, &limits)
}

/// [`hold_temperatures`] against `limits`.
fn clamp_temperatures(cfg: &mut PrintConfig, limits: &Limits) -> Vec<Issue> {
    let mut issues = Vec::new();
    let warn = |code: &'static str, message: String| Issue::new(code, Severity::Warning, message);
    let error = |code: &'static str, message: String| Issue::new(code, Severity::Error, message);
    let nozzle_max = limits
        .nozzle_max_c
        .unwrap_or(crate::gcode_lint::FALLBACK_NOZZLE_C);
    let bed_max = limits.bed_max_c.unwrap_or(crate::gcode_lint::FALLBACK_BED_C);
    for (name, list) in [
        ("nozzle_temperature", &mut cfg.nozzle_temperature),
        (
            "nozzle_temperature_initial_layer",
            &mut cfg.nozzle_temperature_initial_layer,
        ),
    ] {
        for t in list.iter_mut() {
            if !t.is_finite() || *t < 0.0 {
                issues.push(error("temperature", format!("{name} must be 0 or more")));
            } else if *t > nozzle_max {
                issues.push(warn(
                    "nozzle_temperature_clamped",
                    format!("{name} {t} C is above the hotend limit of {nozzle_max} C; using {nozzle_max} C"),
                ));
                *t = nozzle_max;
            }
        }
    }
    for (name, v) in [
        ("hot_plate_temp", &mut cfg.hot_plate_temp),
        (
            "hot_plate_temp_initial_layer",
            &mut cfg.hot_plate_temp_initial_layer,
        ),
    ] {
        if !v.is_finite() || *v < 0.0 {
            issues.push(error("temperature", format!("{name} must be 0 or more")));
        } else if *v > bed_max {
            issues.push(warn(
                "bed_temperature_clamped",
                format!("{name} {v} C is above the bed limit of {bed_max} C; using {bed_max} C"),
            ));
            *v = bed_max;
        }
    }
    // The per-filament lists of every plate type, which the G-code writer and the start G-code variables
    // read from the raw config.
    for key in PLATES
        .iter()
        .flat_map(|(_, k)| [(*k).to_owned(), format!("{k}_initial_layer")])
    {
        if let Some(Value::Array(list)) = cfg.raw.get_mut(&key) {
            for v in list.iter_mut().filter(|v| number(v).is_some_and(|t| t > bed_max)) {
                *v = Value::from(bed_max);
            }
        }
    }
    issues
}

/// Bed and plate temperature keys by Orca's plate type name.
pub(crate) const PLATES: [(&str, &str); 5] = [
    ("Cool Plate", "cool_plate_temp"),
    ("Engineering Plate", "eng_plate_temp"),
    ("High Temp Plate", "hot_plate_temp"),
    ("Textured PEI Plate", "textured_plate_temp"),
    ("Supertack Plate", "supertack_plate_temp"),
];

/// Sets the bed temperatures from the chosen plate type. Runs before the temperature limits, so
/// the plate's temperatures are held to the bed limit like any other.
fn plate_temps(cfg: &mut PrintConfig) -> Vec<Issue> {
    let mut issues = Vec::new();
    // Plate type: use that plate's temperatures, since the engine reads only hot_plate_temp.
    if let Some(Value::String(plate)) = cfg.raw.get("curr_bed_type").cloned()
        && let Some((_, key)) = PLATES.iter().find(|(n, _)| *n == plate)
    {
        let first_key = format!("{key}_initial_layer");
        if let Some(t) = raw_number(cfg, key) {
            if t <= 0.0 {
                issues.push(Issue::new(
                    "plate_unsupported",
                    Severity::Warning,
                    format!("the filament has no bed temperature for the {plate}; it may not stick or may damage the plate"),
                ));
            } else {
                cfg.hot_plate_temp = t;
                cfg.hot_plate_temp_initial_layer =
                    raw_number(cfg, &first_key).filter(|v| *v > 0.0).unwrap_or(t);
            }
        }
    }
    issues
}

/// Hardness of a nozzle type in HRC, 0 when unknown: the table Orca falls back to in
/// `Print::get_hrc_by_nozzle_type` (Print.cpp).
fn nozzle_type_hrc(t: &str) -> f64 {
    match t {
        "hardened_steel" => 55.0,
        "stainless_steel" => 20.0,
        "tungsten_carbide" => 85.0,
        "brass" => 2.0,
        _ => 0.0,
    }
}

/// Abrasive filament on a soft nozzle, checked after slicing against the filaments the print uses
/// (`filament_mm`, per slot; empty counts every filament). Orca only warns (GCodeProcessor.cpp,
/// `process_filaments`, the `NOZZLE_HRC_CHECKER` warning): the nozzle's hardness is `nozzle_hrc`, or
/// when that is 0 the hardness of its `nozzle_type`, and a nozzle still at 0 is not checked. With
/// several nozzles the softest one counts.
pub fn nozzle_hardness(cfg: &PrintConfig, filament_mm: &[f64]) -> Option<Issue> {
    let used = |i: usize| filament_mm.is_empty() || filament_mm.get(i).is_some_and(|mm| *mm > 0.0);
    let required = match cfg.raw.get("required_nozzle_HRC") {
        Some(Value::Array(a)) => a
            .iter()
            .enumerate()
            .filter(|(i, _)| used(*i))
            .filter_map(|(_, v)| number(v))
            .fold(0.0, f64::max),
        Some(v) if used(0) => number(v).unwrap_or(0.0),
        _ => 0.0,
    };
    if required <= 0.0 {
        return None;
    }
    let by_type = match cfg.raw.get("nozzle_type") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(nozzle_type_hrc)
            .reduce(f64::min),
        Some(Value::String(s)) => Some(nozzle_type_hrc(s)),
        _ => None,
    };
    let hrc = match raw_number(cfg, "nozzle_hrc") {
        Some(h) if h > 0.0 => Some(h),
        Some(_) => Some(by_type.unwrap_or(0.0)),
        None => by_type,
    };
    match hrc {
        Some(h) if h >= required || h <= 0.0 => None,
        Some(h) => Some(Issue::new(
            "nozzle_too_soft",
            Severity::Warning,
            format!(
                "the filament needs a nozzle of hardness HRC {required} or more and this printer has HRC {h}; fit a hardened nozzle or change filament"
            ),
        )),
        None => Some(Issue::new(
            "nozzle_hardness_unknown",
            Severity::Warning,
            format!(
                "the filament needs a nozzle of hardness HRC {required} or more and the printer's nozzle is not known; check it before printing"
            ),
        )),
    }
}

/// Material and hardware rules: a PTFE-lined hotend kept below the temperature where the liner
/// breaks down. The nozzle hardness waits for the slice, see [`nozzle_hardness`].
fn check_materials(cfg: &PrintConfig, limits: &Limits) -> Vec<Issue> {
    let mut issues = Vec::new();
    // PTFE-lined hotends.
    if limits.ptfe_lined == Some(true) {
        let hottest = cfg
            .nozzle_temperature
            .iter()
            .chain(&cfg.nozzle_temperature_initial_layer)
            .copied()
            .fold(0.0, f64::max);
        if hottest > PTFE_BLOCK_C {
            issues.push(Issue::new(
                "ptfe_over_limit",
                Severity::Error,
                format!("{hottest} C is above {PTFE_BLOCK_C} C, where a PTFE-lined hotend breaks down and gives off fumes that are harmful to people and pet birds; use an all-metal hotend"),
            ));
        } else if hottest > PTFE_WARN_C {
            issues.push(Issue::new(
                "ptfe_near_limit",
                Severity::Warning,
                format!("{hottest} C is close to the limit of a PTFE-lined hotend ({PTFE_BLOCK_C} C); ventilate and keep pet birds out of the room"),
            ));
        }
    }
    issues
}

/// A PTFE liner starts to degrade above about 240 C and fails quickly at 260 C.
const PTFE_WARN_C: f64 = 240.0;
const PTFE_BLOCK_C: f64 = 260.0;

/// Lowers the speed of every path of a layer to what the machine's axes and the
/// filament's volumetric limit allow, before the time estimate is made from it.
/// A bead at `width` by the layer height and `flow` times its usual cross-section
/// may not push more than `filament_max_volumetric_speed` mm3/s through the nozzle.
pub(crate) fn cap_speeds(layer: &mut crate::output::LayerPaths, cfg: &PrintConfig) {
    let axis = [
        machine_limit(cfg, "machine_max_speed_x"),
        machine_limit(cfg, "machine_max_speed_y"),
    ]
    .into_iter()
    .flatten()
    .reduce(f64::min);
    let height = f64::from(layer.height);
    for p in &mut layer.paths {
        let mut cap = axis.unwrap_or(f64::INFINITY);
        if let Some(v) = flow_cap_mm_s(cfg, p.tool, f64::from(p.width_mm), height) {
            cap = cap.min(v / f64::from(p.flow).max(0.05));
        }
        if cap.is_finite() && f64::from(p.speed_mm_s) > cap {
            #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
            {
                p.speed_mm_s = cap as f32;
            }
        }
    }
}

/// Highest print speed the filament's volumetric limit allows for a line of
/// `width` by `height` mm, in mm/s. `None` when the profile sets no limit.
pub fn flow_cap_mm_s(cfg: &PrintConfig, slot: u8, width: f64, height: f64) -> Option<f64> {
    let limit = match cfg.raw.get("filament_max_volumetric_speed")? {
        Value::Array(a) => a
            .get(usize::from(slot.saturating_sub(1)))
            .or_else(|| a.first())
            .and_then(number)?,
        v => number(v)?,
    };
    let area = crate::gcode::bead_area(width, height);
    (limit > 0.0 && area > 0.0).then(|| limit / area)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Point;
    use crate::output::{Feature, LayerPaths, PathInfo};
    use serde_json::json;

    fn output_with(points: &[(f64, f64)], z: f32) -> SliceOutput {
        let pts: Vec<Point> = points.iter().map(|&(x, y)| Point::from_mm(x, y)).collect();
        let n = u32::try_from(pts.len()).unwrap_or(0);
        SliceOutput {
            layer_count: 1,
            layers: vec![LayerPaths {
                index: 0,
                z,
                height: 0.2,
                points: pts,
                paths: vec![PathInfo {
                    start: 0,
                    end: n,
                    tool: 1,
                    feature: Feature::OuterWall,
                    speed_mm_s: 50.0,
                    width_mm: 0.42,
                    flow: 1.0,
                    dz: 0.0,
                    overhang_fan: false,
                }],
                ..LayerPaths::default()
            }],
            ..SliceOutput::default()
        }
    }

    #[allow(clippy::needless_pass_by_value, reason = "called with json! temporaries")]
    fn cfg(v: Value) -> PrintConfig {
        PrintConfig::from_value(&v).unwrap_or_default()
    }

    #[test]
    fn a_round_bed_rejects_the_corner_of_its_bounding_box() {
        let circle: Vec<Value> = (0..64)
            .map(|i| {
                let a = f64::from(i) * std::f64::consts::TAU / 64.0;
                json!(format!(
                    "{}x{}",
                    100.0 + 100.0 * a.m_cos(),
                    100.0 + 100.0 * a.m_sin()
                ))
            })
            .collect();
        let c = cfg(json!({ "printable_area": circle }));
        assert!(check_toolpaths(&output_with(&[(100.0, 100.0), (150.0, 120.0)], 0.2), &c).is_empty());
        let issues = check_toolpaths(&output_with(&[(100.0, 100.0), (190.0, 190.0)], 0.2), &c);
        assert_eq!(issues.iter().map(|i| i.code).collect::<Vec<_>>(), ["outside_bed"]);
        assert!(
            issues[0].message.ends_with("(X190.0 Y190.0, outer wall)"),
            "{}",
            issues[0].message
        );
        assert!(blocks(&issues));
    }

    #[test]
    fn a_move_through_an_excluded_area_blocks_though_its_ends_lie_clear() {
        // A 2 mm excluded square at the bed's center, and an infill move across it from
        // (118.991, 118.991) to (137.009, 137.009).
        let c = cfg(json!({
            "printable_area": ["0x0", "256x0", "256x256", "0x256"],
            "bed_exclude_area": ["127x127", "129x127", "129x129", "127x129"]
        }));
        let issues = check_toolpaths(&output_with(&[(118.991, 118.991), (137.009, 137.009)], 0.2), &c);
        assert_eq!(
            issues.iter().map(|i| i.code).collect::<Vec<_>>(),
            ["in_exclusion_zone"]
        );
        assert!(
            issues[0].message.contains("X128.0 Y128.0"),
            "{}",
            issues[0].message
        );
        // Along the edge, 0.03 mm inside it, is within the 0.05 mm contact tolerance; 0.1 mm inside is not.
        assert!(check_toolpaths(&output_with(&[(120.0, 127.03), (135.0, 127.03)], 0.2), &c).is_empty());
        assert_eq!(
            check_toolpaths(&output_with(&[(120.0, 127.1), (135.0, 127.1)], 0.2), &c)[0].code,
            "in_exclusion_zone"
        );
        // Past the zone, clear of it.
        assert!(check_toolpaths(&output_with(&[(120.0, 126.9), (135.0, 126.9)], 0.2), &c).is_empty());
    }

    #[test]
    fn a_move_across_the_notch_of_an_l_shaped_bed_is_outside() {
        // Both ends on the bed, the move between them over the notch.
        let c = cfg(json!({ "printable_area": ["0x0", "200x0", "200x100", "100x100", "100x200", "0x200"] }));
        assert!(
            check_toolpaths(
                &output_with(&[(50.0, 150.0), (50.0, 50.0), (150.0, 50.0)], 0.2),
                &c
            )
            .is_empty()
        );
        assert_eq!(
            check_toolpaths(&output_with(&[(90.0, 190.0), (190.0, 90.0)], 0.2), &c)[0].code,
            "outside_bed"
        );
    }

    #[test]
    fn a_rectangular_bed_and_the_height_limit() {
        let c =
            cfg(json!({ "printable_area": ["0x0", "180x0", "180x180", "0x180"], "printable_height": 100 }));
        assert!(check_toolpaths(&output_with(&[(10.0, 10.0), (179.9, 100.0)], 50.0), &c).is_empty());
        assert_eq!(
            check_toolpaths(&output_with(&[(10.0, 10.0), (181.0, 100.0)], 50.0), &c)[0].code,
            "outside_bed"
        );
        assert_eq!(
            check_toolpaths(&output_with(&[(10.0, 10.0)], 100.5), &c)[0].code,
            "over_height"
        );
        let hop = cfg(
            json!({ "printable_area": ["0x0", "180x0", "180x180", "0x180"], "printable_height": 100, "z_hop": 0.8 }),
        );
        assert_eq!(
            check_toolpaths(&output_with(&[(10.0, 10.0)], 99.5), &hop)[0].code,
            "over_height"
        );
    }

    #[test]
    fn a_path_past_its_extruders_reach_blocks() {
        // H2D: the left nozzle reaches x 0 to 325, the right one 25 to 350, on a 350 mm bed.
        let c = cfg(json!({
            "printable_area": ["0x0", "350x0", "350x320", "0x320"],
            "nozzle_diameter": [0.4, 0.4],
            "extruder_printable_area": [
                ["0x0", "325x0", "325x320", "0x320"],
                ["25x0", "350x0", "350x320", "25x320"]
            ]
        }));
        let mapped = |e: u8, pts: &[(f64, f64)]| {
            let mut out = output_with(pts, 0.2);
            out.filament_map = Some(crate::nozzles::Map {
                extruder: vec![e],
                nozzle: vec![0],
                auto: false,
            });
            out
        };
        assert!(check_toolpaths(&mapped(1, &[(100.0, 100.0), (30.0, 100.0)]), &c).is_empty());
        let issues = check_toolpaths(&mapped(1, &[(100.0, 100.0), (10.0, 100.0)]), &c);
        assert_eq!(
            issues.iter().map(|i| i.code).collect::<Vec<_>>(),
            ["outside_extruder_reach"]
        );
        assert!(
            issues[0].message.contains("filament 1") && issues[0].message.contains("extruder 2"),
            "{}",
            issues[0].message
        );
        assert!(blocks(&issues));
        assert_eq!(
            check_toolpaths(&mapped(0, &[(100.0, 100.0), (340.0, 100.0)]), &c)[0].code,
            "outside_extruder_reach"
        );
        // No map, no per-extruder check: the bed alone bounds the path.
        assert!(check_toolpaths(&output_with(&[(10.0, 100.0), (340.0, 100.0)], 0.2), &c).is_empty());
    }

    #[test]
    fn exclusion_zones_block_paths_inside_them() {
        let c = cfg(json!({
            "printable_area": ["0x0", "256x0", "256x256", "0x256"],
            "bed_exclude_area": ["0x0", "18x0", "18x28", "0x28"]
        }));
        assert_eq!(exclude_zones(&c).len(), 1);
        assert!(check_toolpaths(&output_with(&[(30.0, 30.0), (18.0, 10.0)], 0.2), &c).is_empty());
        assert_eq!(
            check_toolpaths(&output_with(&[(30.0, 30.0), (9.0, 14.0)], 0.2), &c)[0].code,
            "in_exclusion_zone"
        );
        let two = cfg(
            json!({ "bed_exclude_area": [["0x0", "10x0", "10x10", "0x10"], ["100x100", "110x100", "110x110", "100x110"]] }),
        );
        assert_eq!(exclude_zones(&two).len(), 2);
        // A flat list longer than four points is a box per four points, as Orca reads it; a short tail and a
        // group without area are dropped.
        let qidi = cfg(json!({
            "printable_area": ["0x0", "305x0", "305x305", "0x305"],
            "bed_exclude_area": ["0x305", "0x302", "35x302", "35x305", "305x305", "305x305", "305x305", "305x20",
                "293x20", "293x0", "305x0", "305x20", "305x305"]
        }));
        assert_eq!(exclude_zones(&qidi).len(), 2);
        assert!(check_toolpaths(&output_with(&[(150.0, 150.0), (160.0, 150.0)], 0.2), &qidi).is_empty());
        assert_eq!(
            check_toolpaths(&output_with(&[(150.0, 150.0), (300.0, 10.0)], 0.2), &qidi)[0].code,
            "in_exclusion_zone"
        );
    }

    #[test]
    fn layer_height_line_width_and_temperatures_are_clamped() {
        // Built directly: PrintConfig::from_value already rejects some of these.
        let mut c = PrintConfig {
            layer_height: 1.2,
            line_width: 3.0,
            nozzle_temperature: vec![480.0],
            hot_plate_temp: 200.0,
            ..PrintConfig::default()
        };
        let limits = Limits {
            nozzle_max_c: Some(300.0),
            bed_max_c: Some(110.0),
            chamber_max_c: None,
            ptfe_lined: None,
        };
        let issues = clamp_config(&mut c, &limits);
        assert!((c.layer_height - 0.4).abs() < 1e-9);
        assert!((c.line_width - 1.0).abs() < 1e-9);
        assert_eq!(c.nozzle_temperature, vec![300.0]);
        assert!((c.hot_plate_temp - 110.0).abs() < 1e-9);
        assert!(!blocks(&issues));
        assert_eq!(issues.len(), 4);
    }

    #[test]
    fn machine_speed_limits_clamp_speeds() {
        let mut c = cfg(
            json!({ "outer_wall_speed": 400, "travel_speed": 700, "machine_max_speed_x": ["500", "200"], "machine_max_speed_y": ["500", "200"] }),
        );
        let issues = clamp_config(&mut c, &Limits::default());
        assert!((c.outer_wall_speed - 400.0).abs() < 1e-9);
        // travel is written as orca writes it, and the firmware caps it per axis
        assert!((c.travel_speed - 700.0).abs() < 1e-9);
        assert!(issues.is_empty());
    }

    #[test]
    fn files_may_not_set_post_process_or_credentials() {
        for k in [
            "post_process",
            "printhost_password",
            "printhost_apikey",
            "printhost_user",
            "print_host_token",
            "bambu_access_code",
        ] {
            assert!(is_never_imported(k), "{k}");
        }
        for k in ["print_host", "layer_height", "machine_start_gcode", "host_type"] {
            assert!(!is_never_imported(k), "{k}");
        }
        let c = cfg(json!({ "layer_height": 0.2, "post_process": ["/bin/sh"], "printhost_apikey": "abc" }));
        assert!(!c.raw.contains_key("post_process") && !c.raw.contains_key("printhost_apikey"));
        assert!(c.raw.contains_key("layer_height"));
    }

    #[test]
    fn vet_custom_blocks_dangerous_text() {
        let c = PrintConfig::default();
        assert!(vet_custom(crate::gcode_lint::Section::Start, "M104 S200", &c).is_ok());
        assert!(vet_custom(crate::gcode_lint::Section::Start, "M500", &c).is_err());
    }

    #[test]
    fn the_nozzle_hardness_check_follows_the_nozzle_type_and_the_filaments_used() {
        let code = |v: Value, used: &[f64]| nozzle_hardness(&cfg(v), used).map(|i| i.code);
        // Hardness 0 with no nozzle type is not checked, as in Orca; a known softer nozzle warns.
        assert_eq!(
            code(json!({ "required_nozzle_HRC": ["40"], "nozzle_hrc": 0 }), &[]),
            None
        );
        assert_eq!(
            code(json!({ "required_nozzle_HRC": ["40"], "nozzle_hrc": 20 }), &[]),
            Some("nozzle_too_soft")
        );
        assert_eq!(
            code(json!({ "required_nozzle_HRC": ["40"] }), &[]),
            Some("nozzle_hardness_unknown")
        );
        assert_eq!(
            code(json!({ "required_nozzle_HRC": ["40"], "nozzle_hrc": 55 }), &[]),
            None
        );
        // The stock Bambu Lab profiles leave nozzle_hrc at 0: the hardness comes from the nozzle type.
        let p1s = |req: Value| json!({ "required_nozzle_HRC": req, "nozzle_hrc": 0, "nozzle_type": ["stainless_steel"] });
        assert_eq!(code(p1s(json!(["40"])), &[]), Some("nozzle_too_soft"));
        assert_eq!(code(p1s(json!(["3"])), &[]), None);
        let hardened = json!({ "required_nozzle_HRC": ["40"], "nozzle_type": "hardened_steel" });
        assert_eq!(code(hardened, &[]), None);
        // Only filaments the print uses count: a carbon fiber spool loaded in slot 2 and not printed is fine.
        assert_eq!(code(p1s(json!(["3", "40"])), &[1200.0, 0.0]), None);
        assert_eq!(
            code(p1s(json!(["3", "40"])), &[1200.0, 35.0]),
            Some("nozzle_too_soft")
        );
    }

    #[test]
    fn plate_type_sets_the_bed_temperature_and_material_rules_apply() {
        let mut c = cfg(
            json!({ "curr_bed_type": "Cool Plate", "cool_plate_temp": ["35"], "hot_plate_temp": ["60"], "cool_plate_temp_initial_layer": ["40"] }),
        );
        let issues = clamp_config(&mut c, &Limits::default());
        assert!(issues.is_empty(), "{issues:?}");
        assert!(
            (c.hot_plate_temp - 35.0).abs() < 1e-9 && (c.hot_plate_temp_initial_layer - 40.0).abs() < 1e-9
        );
        let mut c = cfg(json!({ "curr_bed_type": "Cool Plate", "cool_plate_temp": ["0"] }));
        assert_eq!(
            clamp_config(&mut c, &Limits::default())[0].code,
            "plate_unsupported"
        );
        let mut c = PrintConfig {
            nozzle_temperature: vec![270.0],
            ..PrintConfig::default()
        };
        let ptfe = Limits {
            ptfe_lined: Some(true),
            ..Limits::default()
        };
        assert_eq!(clamp_config(&mut c, &ptfe)[0].code, "ptfe_over_limit");
        c.nozzle_temperature = vec![250.0];
        let i = clamp_config(&mut c, &ptfe);
        assert!(!blocks(&i) && i[0].code == "ptfe_near_limit");
    }

    #[test]
    fn the_volumetric_limit_caps_speed() {
        let c = cfg(json!({ "filament_max_volumetric_speed": ["12"] }));
        let cap = flow_cap_mm_s(&c, 1, 0.42, 0.2).unwrap_or(0.0);
        assert!((cap - 12.0 / crate::gcode::bead_area(0.42, 0.2)).abs() < 1e-9);
        assert!(flow_cap_mm_s(&PrintConfig::default(), 1, 0.42, 0.2).is_none());
    }
}
