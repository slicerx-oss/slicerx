// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Ironing: a slow pass with almost no flow over top surfaces (or every solid surface) that
//! melts the last layer flat. Settings: `ironing_type` (no ironing, top, topmost, solid),
//! `ironing_pattern` (rectilinear, concentric), `ironing_spacing`, `ironing_flow` (percent of the
//! layer height), `ironing_speed`, `ironing_inset`, `ironing_angle` and `ironing_angle_fixed`.
//!
//! The area is the top surfaces (plus bottom surfaces and solid layers for `solid`), kept half a
//! nozzle (or `ironing_inset`) inside the layer's outline. Lines run at the top surface angle
//! plus `ironing_angle`, one sweep in the order of `monotonic`, each line the other way round and joined to the next along
//! the edge when the gap is under three spacings. Each line carries `ironing_flow` percent of a layer of the layer
//! height over the ironing spacing: the volume per millimeter is the nozzle diameter times
//! `layer_height * flow * spacing / nozzle`.

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::Point;
use crate::infill::Iv;
use crate::motion::raw_f;
use crate::output::{Feature, LayerAreas, LayerPaths, PathInfo};
use crate::perimeters::{self, Shapes};

type Pt = [f64; 2];

/// What the profile asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Top,
    Topmost,
    Solid,
}

pub(crate) fn kind(cfg: &PrintConfig) -> Option<Kind> {
    let text = match cfg.raw.get("ironing_type") {
        Some(serde_json::Value::String(s)) => s.as_str(),
        Some(serde_json::Value::Array(a)) => a.first().and_then(|v| v.as_str()).unwrap_or(""),
        _ => "",
    };
    match text {
        "top" => Some(Kind::Top),
        "topmost" => Some(Kind::Topmost),
        "solid" => Some(Kind::Solid),
        _ => None,
    }
}

fn concentric(cfg: &PrintConfig) -> bool {
    matches!(cfg.raw.get("ironing_pattern"), Some(serde_json::Value::String(s)) if s == "concentric")
}

/// Rings of shapes as f64 points in mm.
fn rings(shapes: &Shapes) -> Vec<Vec<Pt>> {
    shapes
        .iter()
        .flat_map(|s| s.iter())
        .map(|c| {
            c.iter()
                .map(|p| {
                    [
                        f64::from(p.x) / crate::geom::SCALE,
                        f64::from(p.y) / crate::geom::SCALE,
                    ]
                })
                .collect()
        })
        .collect()
}

/// Horizontal lines about `spacing` apart through the rings, as polylines joined and ordered by
/// `monotonic`. As Orca does for a full fill, the spacing is widened a little (at most 20
/// percent) so a whole number of lines spans the area, and the first line sits half a spacing in.
fn zigzag(rs: &[Vec<Pt>], spacing: f64, link: f64) -> Vec<Vec<Pt>> {
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for p in rs.iter().flatten() {
        lo = lo.min(p[1]);
        hi = hi.max(p[1]);
    }
    if hi <= lo {
        return Vec::new();
    }
    let width = hi - lo - 1e-4;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a count of lines"
    )]
    let intervals = (width / spacing).floor() as usize;
    let pitch = if intervals == 0 {
        spacing
    } else {
        #[allow(clippy::cast_precision_loss, reason = "a count of lines")]
        let p = width / intervals as f64;
        p.min(spacing * 1.2)
    };
    let units = |mm: f64| -> i64 {
        #[allow(clippy::cast_possible_truncation, reason = "plate coordinates")]
        {
            (mm * crate::geom::SCALE).round() as i64
        }
    };
    let pitch_u = units(pitch).max(1);
    let mut spans: Vec<Iv> = Vec::new();
    let mut k = 0i32;
    let mut y = lo + pitch / 2.0;
    while y < hi {
        let mut xs: Vec<f64> = Vec::new();
        for r in rs {
            let n = r.len();
            for i in 0..n {
                let (Some(a), Some(b)) = (r.get(i), r.get((i + 1) % n)) else {
                    continue;
                };
                if (a[1] > y) != (b[1] > y) {
                    xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
                }
            }
        }
        crate::sorting::sort_by(&mut xs, |p, q| {
            p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal)
        });
        for &[a, b] in xs.as_chunks::<2>().0 {
            if b - a > 1e-3 {
                spans.push(Iv {
                    k,
                    t0: units(a),
                    t1: units(b),
                });
            }
        }
        k += 1;
        y += pitch;
    }
    let y0 = lo + pitch / 2.0;
    let to_point = |s: i64, t: i64| {
        #[allow(clippy::cast_precision_loss, reason = "plate coordinates")]
        Point::from_mm(t as f64 / crate::geom::SCALE, y0 + s as f64 / crate::geom::SCALE)
    };
    crate::monotonic::polylines_with(
        &spans,
        pitch_u,
        crate::monotonic::Links {
            edge: None,
            max: link,
            chord_fallback: false,
        },
        &to_point,
    )
    .into_iter()
    .map(|pl| pl.into_iter().map(|p| [p.x_mm(), p.y_mm()]).collect())
    .collect()
}

fn rotate(p: Pt, a: f64) -> Pt {
    let (s, c) = a.m_sin_cos();
    [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}

/// The ironing area of a layer, or None when this layer is not ironed.
fn area(
    areas: &LayerAreas,
    cfg: &PrintConfig,
    k: Kind,
    topmost: bool,
    nozzle: f64,
    inset: f64,
) -> Option<Shapes> {
    let shells = cfg.shell_layers(cfg.layer_height);
    if k != Kind::Solid && (shells.0 == 0 || (k == Kind::Topmost && !topmost)) {
        return None;
    }
    let polys: Shapes = if k != Kind::Solid {
        areas.top.clone()
    } else if cfg.sparse_infill_density > 95.0 {
        areas.slice.clone()
    } else {
        perimeters::union_all(&[&areas.top, &areas.bottom, &areas.solid])
    };
    if polys.is_empty() {
        return None;
    }
    let edge = crate::geom::mm(if inset == 0.0 { nozzle / 2.0 } else { inset });
    let trimmed = perimeters::intersection(&polys, &perimeters::offset(&areas.slice, -edge));
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Adds the ironing paths of `layer` to `out`, printed last, and returns whether any were added.
pub(crate) fn add(
    out: &mut LayerPaths,
    areas: &LayerAreas,
    cfg: &PrintConfig,
    topmost: bool,
    base_angle_deg: f64,
) -> bool {
    let Some(k) = kind(cfg) else { return false };
    let nozzle = cfg.nozzle_diameter;
    let spacing = raw_f(cfg, "ironing_spacing").filter(|v| *v > 0.0).unwrap_or(0.1);
    let flow_pct = raw_f(cfg, "ironing_flow").unwrap_or(10.0).max(0.0);
    let speed = raw_f(cfg, "ironing_speed").filter(|v| *v > 0.0).unwrap_or(20.0);
    let inset = raw_f(cfg, "ironing_inset").unwrap_or(0.0).max(0.0);
    let fixed = crate::firmware::truthy(cfg, "ironing_angle_fixed");
    let angle = (if fixed { 0.0 } else { base_angle_deg }) + raw_f(cfg, "ironing_angle").unwrap_or(0.0);
    let Some(region) = area(areas, cfg, k, topmost, nozzle, inset) else {
        return false;
    };
    // The top surface's filament irons (Orca: `top_surface_filament_id`), else the layer's last.
    let tool = out
        .paths
        .iter()
        .rev()
        .find(|p| p.feature == Feature::TopSurface)
        .or_else(|| out.paths.last())
        .map_or(1, |p| p.tool)
        .max(1);
    // The extrusion: height from the flow percent, width from the nozzle, flow multiplier for the writer's bead.
    let layer_h = f64::from(out.height);
    let ext_h = layer_h * flow_pct / 100.0 * spacing / nozzle;
    let width = nozzle + ext_h * (1.0 - std::f64::consts::FRAC_PI_4);
    let flow = nozzle * ext_h / crate::gcode::bead_area(width, layer_h).max(1e-9);
    let polylines: Vec<Vec<Pt>> = if concentric(cfg) {
        crate::surface::fill(&region, crate::surface::Curve::Concentric, spacing, 0.0)
            .into_iter()
            .map(|pl| pl.into_iter().map(|p| [p.x_mm(), p.y_mm()]).collect())
            .collect()
    } else {
        let a = angle.to_radians();
        let rs: Vec<Vec<Pt>> = rings(&region)
            .into_iter()
            .map(|r| r.into_iter().map(|p| rotate(p, -a)).collect())
            .collect();
        zigzag(&rs, spacing, 3.0 * spacing)
            .into_iter()
            .map(|pl| pl.into_iter().map(|p| rotate(p, a)).collect())
            .collect()
    };
    let mut added = false;
    for pl in polylines {
        if pl.len() < 2 {
            continue;
        }
        let start = u32::try_from(out.points.len()).unwrap_or(u32::MAX);
        out.points.extend(pl.iter().map(|p| Point::from_mm(p[0], p[1])));
        let end = u32::try_from(out.points.len()).unwrap_or(u32::MAX);
        #[allow(clippy::cast_possible_truncation, reason = "speeds and widths are small")]
        out.paths.push(PathInfo {
            start,
            end,
            tool,
            feature: Feature::Ironing,
            speed_mm_s: speed as f32,
            width_mm: width as f32,
            flow: flow as f32,
            dz: 0.0,
            overhang_fan: false,
            owner: crate::preview::OBJECT_NONE,
        });
        added = true;
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<IntPoint<i32>> {
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            .iter()
            .map(|&(x, y)| IntPoint::new(crate::geom::mm(x), crate::geom::mm(y)))
            .collect()
    }

    fn cfg(kind: &str) -> PrintConfig {
        let mut c = PrintConfig::default();
        for (k, v) in [
            ("ironing_type", serde_json::json!(kind)),
            ("ironing_spacing", serde_json::json!(0.5)),
            ("ironing_flow", serde_json::json!(10)),
            ("ironing_speed", serde_json::json!(25)),
        ] {
            c.raw.insert(k.into(), v);
        }
        c
    }

    fn layer() -> (LayerPaths, LayerAreas) {
        let slice: Shapes = vec![vec![square(0.0, 0.0, 20.0, 10.0)]];
        let areas = LayerAreas {
            slice: slice.clone(),
            top: slice,
            bottom: Vec::new(),
            solid: Vec::new(),
        };
        (
            LayerPaths {
                height: 0.2,
                z: 5.0,
                ..LayerPaths::default()
            },
            areas,
        )
    }

    #[test]
    fn a_top_surface_gets_lines_at_the_spacing_with_a_tenth_of_the_flow() {
        let (mut out, areas) = layer();
        assert!(add(&mut out, &areas, &cfg("top"), false, 0.0));
        assert!(
            out.paths
                .iter()
                .all(|p| p.feature == Feature::Ironing && (p.speed_mm_s - 25.0).abs() < 1e-6)
        );
        // 10 mm of height at 0.5 mm: about 19 lines, joined into few polylines.
        let segments: usize = out.paths.iter().map(|p| (p.end - p.start) as usize - 1).sum();
        assert!(segments > 25, "{segments}");
        // The volume per millimeter: nozzle * layer * 10% * spacing / nozzle = 0.2 * 0.1 * 0.5.
        let p = out.paths[0];
        let vol = crate::gcode::bead_area(f64::from(p.width_mm), 0.2) * f64::from(p.flow);
        assert!((vol - 0.4 * (0.2 * 0.1 * 0.5 / 0.4)).abs() < 1e-4, "{vol}");
        // Kept half a nozzle inside the outline.
        let pts = &out.points;
        assert!(
            pts.iter()
                .all(|q| q.x_mm() >= 0.19 && q.x_mm() <= 19.81 && q.y_mm() >= 0.19 && q.y_mm() <= 9.81)
        );
    }

    #[test]
    fn topmost_irons_only_the_last_layer_and_none_irons_nothing() {
        let (mut out, areas) = layer();
        assert!(!add(&mut out, &areas, &cfg("topmost"), false, 0.0));
        assert!(add(&mut out, &areas, &cfg("topmost"), true, 0.0));
        let (mut out2, areas2) = layer();
        assert!(!add(&mut out2, &areas2, &PrintConfig::default(), true, 0.0));
    }

    #[test]
    fn concentric_makes_nested_loops_and_the_angle_turns_the_lines() {
        let (mut out, areas) = layer();
        let mut c = cfg("top");
        c.raw
            .insert("ironing_pattern".into(), serde_json::json!("concentric"));
        assert!(add(&mut out, &areas, &c, false, 0.0));
        assert!(out.paths.len() >= 8, "{} loops", out.paths.len());
        let (mut a, areas_a) = layer();
        add(&mut a, &areas_a, &cfg("top"), false, 0.0);
        let (mut b, areas_b) = layer();
        let mut turned = cfg("top");
        turned.raw.insert("ironing_angle".into(), serde_json::json!(90));
        add(&mut b, &areas_b, &turned, false, 0.0);
        let dy = |l: &LayerPaths| {
            l.path_points(&l.paths[0])
                .windows(2)
                .map(|w| (w[1].y - w[0].y).abs())
                .max()
                .unwrap()
        };
        assert!(dy(&a) < dy(&b), "a turned line runs along y");
    }
}
