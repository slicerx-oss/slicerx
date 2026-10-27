// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Ironing: a slow pass with almost no flow over top surfaces (or every solid surface) that
//! melts the last layer flat. Settings: `ironing_type` (no ironing, top, topmost, solid),
//! `ironing_pattern` (rectilinear, concentric), `ironing_spacing`, `ironing_flow` (percent of the
//! layer height), `ironing_speed` (the first layer's speed on the first layer), `ironing_inset`,
//! `ironing_angle` (or `ironing_direction`, its name in Bambu Lab projects, while `ironing_angle` is
//! 0) and `ironing_angle_fixed`. The ironing filament's own `filament_ironing_flow`,
//! `filament_ironing_spacing` and `filament_ironing_inset` replace the process values when set.
//!
//! The area is the top surfaces (plus bottom surfaces and solid layers for `solid`), kept half a
//! nozzle (or `ironing_inset`) inside the layer's outline. Under `solid`, an object whose layer has no
//! sparse infill irons all of its outline, over the walls. Lines run at the top surface angle
//! plus `ironing_angle`, one sweep in the order of `monotonic`, each line the other way round and joined to the next along
//! the edge when the gap is under three spacings. Each line carries `ironing_flow` percent of a layer of the layer
//! height over the ironing spacing: the volume per millimeter is the nozzle diameter times
//! `layer_height * flow * spacing / nozzle`. The speed is held to `filament_max_volumetric_speed` over that volume,
//! as every other feature's is.

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

/// What ironing every solid surface irons on a layer under full density. An object whose part of the layer has no
/// sparse infill is solid through, so all of it is ironed, over the walls too; on an object with sparse infill only
/// its solid surfaces are, as they are filled inside the walls. A layer with no solid surface at all (walls only)
/// irons nothing.
fn solid_area(areas: &LayerAreas) -> Shapes {
    let fill = perimeters::union_all(&[&areas.top, &areas.bottom, &areas.solid]);
    if fill.is_empty() || areas.sparse.is_empty() {
        return if fill.is_empty() {
            fill
        } else {
            areas.slice.clone()
        };
    }
    let whole: Vec<&Shapes> = areas
        .objects
        .iter()
        .filter(|o| {
            perimeters::intersection(o, &areas.sparse).is_empty()
                && !perimeters::intersection(o, &fill).is_empty()
        })
        .collect();
    if whole.is_empty() {
        return fill;
    }
    let mut parts = whole;
    parts.push(&fill);
    perimeters::union_all(&parts)
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
        solid_area(areas)
    };
    if polys.is_empty() {
        return None;
    }
    let edge = crate::geom::mm(if inset == 0.0 { nozzle / 2.0 } else { inset });
    let trimmed = perimeters::intersection(&polys, &perimeters::offset(&areas.slice, -edge));
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Adds the ironing paths of `layer` to `out` and returns whether any were added. `owners` is the part of the layer
/// each filament irons (its top surface filament, as the feature filament settings assign it, with the regions it
/// covers). Each filament irons its own part right after the last of its own paths, so the layer still ends on the
/// filament its planned order ends on and the next layer starts on the filament the plan says it does. With one
/// filament ironing, it irons the whole area. With no owners (no regions), the layer's last top surface's filament
/// irons, else the first.
pub(crate) fn add(
    out: &mut LayerPaths,
    areas: &LayerAreas,
    cfg: &PrintConfig,
    topmost: bool,
    base_angle_deg: f64,
    owners: &[(u8, Shapes)],
) -> bool {
    let Some(k) = kind(cfg) else { return false };
    let nozzle = cfg.nozzle_diameter;
    let spacing = raw_f(cfg, "ironing_spacing").filter(|v| *v > 0.0).unwrap_or(0.1);
    // Percent of a layer's flow: `15%` as a project file writes it, or 15.
    let flow_pct = cfg
        .raw
        .get("ironing_flow")
        .and_then(|v| crate::config::float_or_percent(v, 100.0))
        .unwrap_or(10.0)
        .max(0.0);
    // The first layer (only solid irons it, and a raft makes it an ordinary layer) irons at the first layer's speed:
    // `initial_layer_speed` on Bambu Lab printers, `initial_layer_infill_speed` on the others.
    let first = if out.index == 0 && crate::raft::layers_asked(cfg) == 0 {
        Some(if crate::firmware::bambu_printer(cfg, cfg.gcode_flavor) {
            cfg.initial_layer_speed
        } else {
            cfg.initial_layer_infill_speed
        })
    } else {
        None
    };
    let speed = first
        .filter(|v| *v > 0.0)
        .or_else(|| raw_f(cfg, "ironing_speed").filter(|v| *v > 0.0))
        .unwrap_or(20.0);
    let inset = raw_f(cfg, "ironing_inset").unwrap_or(0.0).max(0.0);
    let fixed = crate::firmware::truthy(cfg, "ironing_angle_fixed");
    // The turn from the top surface direction: `ironing_angle`, or in a project that names it `ironing_direction`
    // (stock 45 on Bambu Lab printers), that key. The defaults always hold `ironing_angle` at 0, so a project's
    // `ironing_direction` counts unless `ironing_angle` is set to something else.
    let turn = raw_f(cfg, "ironing_angle")
        .filter(|a| *a != 0.0)
        .or_else(|| raw_f(cfg, "ironing_direction"))
        .unwrap_or(0.0);
    let angle = (if fixed { 0.0 } else { base_angle_deg }) + turn;
    let Some(region) = area(areas, cfg, k, topmost, nozzle, inset) else {
        return false;
    };
    let knobs = (spacing, flow_pct, speed, angle);
    // Each filament's share of the area. When one filament irons it all, the area is kept whole.
    let mut parts: Vec<(u8, Shapes)> = owners
        .iter()
        .map(|(t, own)| (*t, perimeters::intersection(&region, own)))
        .filter(|(_, r)| !r.is_empty())
        .collect();
    let whole = parts.len() < 2;
    if whole {
        // The top surface's filament irons (Orca: `top_surface_filament_id`): the one owner's, else the layer's last
        // top surface's.
        let tool = parts
            .first()
            .map(|(t, _)| *t)
            .or_else(|| {
                out.paths
                    .iter()
                    .rev()
                    .find(|p| p.feature == Feature::TopSurface)
                    .map(|p| p.tool)
            })
            .or_else(|| owners.first().map(|(t, _)| *t))
            .unwrap_or(1)
            .max(1);
        parts = vec![(tool, region)];
    }
    let mut added = false;
    for (tool, part) in &parts {
        // Ironing follows a top surface printed in its filament, so a layer that never loads it irons nothing with it.
        let Some(at) = spot(out, *tool) else { continue };
        // The filament's own ironing flow, spacing and inset, where it sets them (not empty and not `nil`), replace the
        // process values. Its ironing speed does not: the process speed stays.
        let own = |key: &str| cfg.filament_override(key, *tool);
        let tool_flow = own("ironing_flow")
            .and_then(|v| crate::config::float_or_percent(v, 100.0))
            .map_or(knobs.1, |v| v.max(0.0));
        let tool_spacing = own("ironing_spacing")
            .and_then(plain)
            .filter(|v| *v > 0.0)
            .unwrap_or(knobs.0);
        let tool_inset = own("ironing_inset").and_then(plain).map_or(inset, |v| v.max(0.0));
        // Another inset trims the filament's share again from the surfaces.
        let trimmed;
        let part = if (tool_inset - inset).abs() > f64::EPSILON {
            let Some(r) = area(areas, cfg, k, topmost, nozzle, tool_inset) else {
                continue;
            };
            trimmed = match owners.iter().find(|(t, _)| t == tool) {
                Some((_, own)) if !whole => perimeters::intersection(&r, own),
                _ => r,
            };
            &trimmed
        } else {
            part
        };
        let paths = lines(out, part, cfg, *tool, (tool_spacing, tool_flow, knobs.2, knobs.3));
        added |= !paths.is_empty();
        out.paths.splice(at..at, paths);
    }
    added
}

/// A number, or a number written as text.
fn plain(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
}

/// Where ironing on `tool` goes so that it never adds a tool change: right after that filament's last path that is
/// not the prime tower (its tower rows before a change stay right before the change), or at the end when every later
/// path is on the same filament. None when the layer never loads the filament (an empty layer takes it at the end).
fn spot(out: &LayerPaths, tool: u8) -> Option<usize> {
    let end = out.paths.len();
    match out
        .paths
        .iter()
        .rposition(|p| p.tool == tool && p.feature != Feature::PrimeTower)
    {
        Some(i) if out.paths.iter().skip(i + 1).all(|p| p.tool == tool) => Some(end),
        Some(i) => Some(i + 1),
        None => out.paths.last().is_none_or(|p| p.tool == tool).then_some(end),
    }
}

/// The ironing lines over `region` on `tool`: their points go to the end of `out.points`, the paths are returned.
/// `knobs` is the spacing, the flow percent, the speed and the line angle.
fn lines(
    out: &mut LayerPaths,
    region: &Shapes,
    cfg: &PrintConfig,
    tool: u8,
    knobs: (f64, f64, f64, f64),
) -> Vec<PathInfo> {
    let (spacing, flow_pct, speed, angle) = knobs;
    let nozzle = cfg.nozzle_diameter;
    // The extrusion: height from the flow percent, width from the nozzle, flow multiplier for the writer's bead.
    let layer_h = f64::from(out.height);
    // The ironed height comes from the layer height setting, not this layer's own height: a thicker first layer, a
    // height range or a smart layer irons the same mm3 per mm as a layer at the setting. The setting is rounded to the
    // layer's f32 height, so a layer at the setting irons exactly as before.
    #[allow(clippy::cast_possible_truncation, reason = "layer heights are small")]
    let set_h = f64::from(cfg.layer_height as f32);
    let ext_h = set_h * flow_pct / 100.0 * spacing / nozzle;
    let width = nozzle + ext_h * (1.0 - std::f64::consts::FRAC_PI_4);
    let flow = nozzle * ext_h / crate::gcode::bead_area(width, layer_h).max(1e-9);
    #[allow(clippy::cast_possible_truncation, reason = "speeds and widths are small")]
    let (width, flow) = (width as f32, flow as f32);
    let speed = capped(cfg, out.index == 0, tool, (width, flow, out.height), speed);
    let polylines: Vec<Vec<Pt>> = if concentric(cfg) {
        crate::surface::fill(region, crate::surface::Curve::Concentric, spacing, 0.0)
            .into_iter()
            .map(|pl| pl.into_iter().map(|p| [p.x_mm(), p.y_mm()]).collect())
            .collect()
    } else {
        let a = angle.to_radians();
        let rs: Vec<Vec<Pt>> = rings(region)
            .into_iter()
            .map(|r| r.into_iter().map(|p| rotate(p, -a)).collect())
            .collect();
        zigzag(&rs, spacing, 3.0 * spacing)
            .into_iter()
            .map(|pl| pl.into_iter().map(|p| rotate(p, a)).collect())
            .collect()
    };
    let mut paths = Vec::new();
    for pl in polylines {
        if pl.len() < 2 {
            continue;
        }
        let start = u32::try_from(out.points.len()).unwrap_or(u32::MAX);
        out.points.extend(pl.iter().map(|p| Point::from_mm(p[0], p[1])));
        let end = u32::try_from(out.points.len()).unwrap_or(u32::MAX);
        #[allow(clippy::cast_possible_truncation, reason = "speeds and widths are small")]
        paths.push(PathInfo {
            tower_wipe: false,
            tower_hop: false,
            slow_span: false,
            start,
            end,
            tool,
            feature: Feature::Ironing,
            speed_mm_s: speed as f32,
            width_mm: width,
            flow,
            dz: 0.0,
            overhang_fan: false,
            owner: crate::preview::OBJECT_NONE,
        });
    }
    paths
}

/// `speed` held to the filament's volumetric limit, as every other feature is: `filament_max_volumetric_speed` over
/// the bead of `width` by `height` mm times its `flow` and the flow multipliers the ironing E carries
/// ([`crate::config::CapFlow`]). The bead is the one written, so the limit holds the mm3/s the lines really extrude.
fn capped(cfg: &PrintConfig, first_layer: bool, tool: u8, bead: (f32, f32, f32), speed: f64) -> f64 {
    let (width, flow, height) = bead;
    let cap = crate::tower::per_slot_raw(cfg, "filament_max_volumetric_speed", tool, 0.0);
    let mm3 = crate::gcode::bead_area(f64::from(width), f64::from(height))
        * f64::from(flow)
        * cfg.cap_flow(first_layer).ratio(tool, Feature::Ironing);
    if cap > 0.0 && mm3 > 0.0 {
        speed.min(cap / mm3)
    } else {
        speed
    }
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
            ..LayerAreas::default()
        };
        (
            LayerPaths {
                index: 24,
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
        assert!(add(&mut out, &areas, &cfg("top"), false, 0.0, &[]));
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
    fn a_flow_written_as_a_percent_reads_as_that_percent() {
        // A project file writes the flow as "15%", a request as 15: the same lines either way, and not the 10% default.
        let flow = |v: serde_json::Value| {
            let (mut out, areas) = layer();
            let mut c = cfg("top");
            c.raw.insert("ironing_flow".into(), v);
            add(&mut out, &areas, &c, false, 0.0, &[]);
            out.paths[0].flow
        };
        assert!((flow(serde_json::json!("15%")) - flow(serde_json::json!(15))).abs() < 1e-6);
        assert!(flow(serde_json::json!("15%")) > flow(serde_json::json!(10)) * 1.2);
    }

    #[test]
    fn topmost_irons_only_the_last_layer_and_none_irons_nothing() {
        let (mut out, areas) = layer();
        assert!(!add(&mut out, &areas, &cfg("topmost"), false, 0.0, &[]));
        assert!(add(&mut out, &areas, &cfg("topmost"), true, 0.0, &[]));
        let (mut out2, areas2) = layer();
        assert!(!add(&mut out2, &areas2, &PrintConfig::default(), true, 0.0, &[]));
    }

    #[test]
    fn concentric_makes_nested_loops_and_the_angle_turns_the_lines() {
        let (mut out, areas) = layer();
        let mut c = cfg("top");
        c.raw
            .insert("ironing_pattern".into(), serde_json::json!("concentric"));
        assert!(add(&mut out, &areas, &c, false, 0.0, &[]));
        assert!(out.paths.len() >= 8, "{} loops", out.paths.len());
        let (mut a, areas_a) = layer();
        add(&mut a, &areas_a, &cfg("top"), false, 0.0, &[]);
        let (mut b, areas_b) = layer();
        let mut turned = cfg("top");
        turned.raw.insert("ironing_angle".into(), serde_json::json!(90));
        add(&mut b, &areas_b, &turned, false, 0.0, &[]);
        let dy = |l: &LayerPaths| {
            l.path_points(&l.paths[0])
                .windows(2)
                .map(|w| (w[1].y - w[0].y).abs())
                .max()
                .unwrap()
        };
        assert!(dy(&a) < dy(&b), "a turned line runs along y");
    }

    #[test]
    fn a_filament_the_layer_never_loads_irons_nothing_and_adds_no_change() {
        let (mut out, areas) = layer();
        let c = cfg("top");
        let walls = lines(&mut out, &areas.slice, &c, 1, (0.5, 10.0, 25.0, 0.0));
        out.paths.extend(walls);
        let before = out.paths.len();
        let owners = vec![(2u8, areas.slice.clone())];
        assert!(!add(&mut out, &areas, &c, false, 0.0, &owners));
        assert_eq!(out.paths.len(), before);
        assert!(out.paths.iter().all(|p| p.tool == 1));
        // The filament the layer does load irons, at the end where it already is.
        let owners = vec![(1u8, areas.slice.clone())];
        assert!(add(&mut out, &areas, &c, false, 0.0, &owners));
        assert!(out.paths.len() > before && out.paths.iter().all(|p| p.tool == 1));
    }

    /// The direction of the longest ironing segment of `c` on a top surface at `base` degrees, in degrees from 0 to 180.
    fn line_direction(c: &PrintConfig, base: f64) -> f64 {
        let (mut out, areas) = layer();
        assert!(add(&mut out, &areas, c, false, base, &[]));
        let mut best = (0.0, 0.0);
        for p in &out.paths {
            for w in out.path_points(p).windows(2) {
                let (dx, dy) = (w[1].x_mm() - w[0].x_mm(), w[1].y_mm() - w[0].y_mm());
                let len = dx.m_hypot(dy);
                if len > best.0 {
                    best = (len, dy.m_atan2(dx).to_degrees().rem_euclid(180.0));
                }
            }
        }
        best.1
    }

    #[test]
    fn a_project_ironing_direction_turns_the_lines_from_the_top_surface() {
        let bambu = |dir: f64| {
            let mut c = cfg("top");
            c.raw
                .insert("printer_model".into(), serde_json::json!("Bambu Lab A1"));
            c.raw
                .insert("ironing_direction".into(), serde_json::json!(dir.to_string()));
            c
        };
        // 30 degrees from the top surface: 75 over a 45 degree top surface, 165 over a 135 degree one.
        let d = line_direction(&bambu(30.0), 45.0);
        assert!((d - 75.0).abs() < 0.5, "{d}");
        let d = line_direction(&bambu(30.0), 135.0);
        assert!((d - 165.0).abs() < 0.5, "{d}");
        // At 0 the lines follow the top surface, as they do with no ironing_direction at all.
        let d = line_direction(&bambu(0.0), 45.0);
        assert!((d - 45.0).abs() < 0.5, "{d}");
        let d = line_direction(&bambu(0.0), 135.0);
        assert!((d - 135.0).abs() < 0.5, "{d}");
        let d = line_direction(&cfg("top"), 45.0);
        assert!((d - 45.0).abs() < 0.5, "{d}");
        // The config holds the default ironing_angle of 0, as every config does; one set to something else wins over
        // ironing_direction.
        let mut both = bambu(30.0);
        both.raw.insert("ironing_angle".into(), serde_json::json!(10));
        let d = line_direction(&both, 45.0);
        assert!((d - 55.0).abs() < 0.5, "{d}");
    }

    /// Solid ironing at 0.1 mm on a layer: `slice`, its solid fill `solid`, its sparse infill `sparse` and its
    /// objects' parts `objects`. Returns the ironing points in mm (empty when nothing is ironed).
    fn solid_points(
        slice: Shapes,
        solid: Shapes,
        sparse: Shapes,
        objects: Vec<Shapes>,
        inset: f64,
    ) -> Vec<Pt> {
        solid_segments(slice, solid, sparse, objects, inset)
            .into_iter()
            .flatten()
            .collect()
    }

    /// [`solid_points`] as the segments of the ironing paths.
    fn solid_segments(
        slice: Shapes,
        solid: Shapes,
        sparse: Shapes,
        objects: Vec<Shapes>,
        inset: f64,
    ) -> Vec<[Pt; 2]> {
        let mut c = cfg("solid");
        c.raw.insert("ironing_spacing".into(), serde_json::json!(0.1));
        c.raw.insert("ironing_inset".into(), serde_json::json!(inset));
        let areas = LayerAreas {
            slice,
            solid,
            sparse,
            objects,
            ..LayerAreas::default()
        };
        let mut out = LayerPaths {
            index: 24,
            height: 0.2,
            z: 5.0,
            ..LayerPaths::default()
        };
        add(&mut out, &areas, &c, false, 0.0, &[]);
        out.paths
            .iter()
            .flat_map(|p| {
                out.path_points(p)
                    .windows(2)
                    .map(|w| [[w[0].x_mm(), w[0].y_mm()], [w[1].x_mm(), w[1].y_mm()]])
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// The extents of `pts`: `[x0, y0, x1, y1]`.
    fn extents(pts: &[Pt]) -> [f64; 4] {
        pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |e, p| {
            [e[0].min(p[0]), e[1].min(p[1]), e[2].max(p[0]), e[3].max(p[1])]
        })
    }

    /// Whether `pts` stay inside `want` and reach within `reach` of each of its sides.
    fn fills(pts: &[Pt], want: [f64; 4], reach: f64) -> bool {
        let e = extents(pts);
        !pts.is_empty()
            && e[0] >= want[0] - 1e-3
            && e[1] >= want[1] - 1e-3
            && e[2] <= want[2] + 1e-3
            && e[3] <= want[3] + 1e-3
            && e[0] - want[0] <= reach
            && e[1] - want[1] <= reach
            && want[2] - e[2] <= reach
            && want[3] - e[3] <= reach
    }

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        vec![vec![square(x0, y0, x1, y1)]]
    }

    #[test]
    fn solid_ironing_irons_a_layer_with_no_sparse_infill_out_to_its_outline() {
        // The fill stops 1 mm inside the outline, at the walls; the ironing runs over them to half a nozzle inside it.
        let pts = solid_points(
            rect(0.0, 0.0, 20.0, 10.0),
            rect(1.0, 1.0, 19.0, 9.0),
            Vec::new(),
            Vec::new(),
            0.0,
        );
        assert!(fills(&pts, [0.2, 0.2, 19.8, 9.8], 0.06), "{:?}", extents(&pts));
    }

    #[test]
    fn solid_ironing_of_a_whole_layer_keeps_the_inset() {
        let pts = solid_points(
            rect(0.0, 0.0, 20.0, 10.0),
            rect(1.0, 1.0, 19.0, 9.0),
            Vec::new(),
            Vec::new(),
            0.6,
        );
        assert!(fills(&pts, [0.6, 0.6, 19.4, 9.4], 0.06), "{:?}", extents(&pts));
        // An inset reaching the fill irons the same region either way.
        let pts = solid_points(
            rect(0.0, 0.0, 20.0, 10.0),
            rect(1.0, 1.0, 19.0, 9.0),
            Vec::new(),
            Vec::new(),
            1.0,
        );
        assert!(fills(&pts, [1.0, 1.0, 19.0, 9.0], 0.06), "{:?}", extents(&pts));
    }

    #[test]
    fn solid_ironing_of_a_whole_layer_keeps_its_edge_around_a_hole() {
        let mut hole = square(8.0, 4.0, 12.0, 6.0);
        hole.reverse();
        let slice: Shapes = vec![vec![square(0.0, 0.0, 20.0, 10.0), hole]];
        let solid = perimeters::offset(&slice, -crate::geom::mm(1.0));
        let segs = solid_segments(slice, solid, Vec::new(), Vec::new(), 0.0);
        let pts: Vec<Pt> = segs.iter().flatten().copied().collect();
        assert!(fills(&pts, [0.2, 0.2, 19.8, 9.8], 0.06), "{:?}", extents(&pts));
        // Nothing inside the hole grown by the edge, and the lines reach within 0.06 of it on every side.
        let inside =
            |p: &Pt| p[0] > 7.8 + 1e-3 && p[0] < 12.2 - 1e-3 && p[1] > 3.8 + 1e-3 && p[1] < 6.2 - 1e-3;
        assert!(!pts.iter().any(inside));
        let across = |p: &Pt| p[1] > 3.8 && p[1] < 6.2;
        assert!(
            pts.iter()
                .any(|p| across(p) && (7.74..=7.8 + 1e-3).contains(&p[0]))
        );
        assert!(
            pts.iter()
                .any(|p| across(p) && (12.2 - 1e-3..=12.26).contains(&p[0]))
        );
        // The heights of the lines that pass under or over the whole hole.
        let ys: Vec<f64> = segs
            .iter()
            .filter(|[a, b]| (a[1] - b[1]).abs() < 1e-6 && a[0].min(b[0]) < 7.8 && a[0].max(b[0]) > 12.2)
            .map(|[a, _]| a[1])
            .collect();
        assert!(ys.iter().any(|y| (3.74..=3.8 + 1e-3).contains(y)), "{ys:?}");
        assert!(ys.iter().any(|y| (6.2 - 1e-3..=6.26).contains(y)), "{ys:?}");
    }

    #[test]
    fn solid_ironing_of_a_layer_with_sparse_infill_irons_only_its_solid_fill() {
        let pts = solid_points(
            rect(0.0, 0.0, 20.0, 10.0),
            rect(1.0, 1.0, 19.0, 5.0),
            rect(1.0, 5.0, 19.0, 9.0),
            Vec::new(),
            0.0,
        );
        assert!(fills(&pts, [1.0, 1.0, 19.0, 5.0], 0.06), "{:?}", extents(&pts));
        // Walls only, with no fill of either kind: nothing to iron.
        let pts = solid_points(
            rect(0.0, 0.0, 20.0, 10.0),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            0.0,
        );
        assert!(pts.is_empty());
    }

    #[test]
    fn solid_ironing_decides_whole_layers_per_object() {
        // Two islands: the left one all solid, the right one with sparse infill.
        let left = rect(0.0, 0.0, 10.0, 10.0);
        let right = rect(15.0, 0.0, 25.0, 10.0);
        let slice = perimeters::union_all(&[&left, &right]);
        let solid = rect(1.0, 1.0, 9.0, 9.0);
        let sparse = rect(16.0, 1.0, 24.0, 9.0);
        // As two objects, the left one irons out to its outline and the right one has no solid to iron.
        let pts = solid_points(
            slice.clone(),
            solid.clone(),
            sparse.clone(),
            vec![left, right],
            0.0,
        );
        assert!(fills(&pts, [0.2, 0.2, 9.8, 9.8], 0.06), "{:?}", extents(&pts));
        // As one object, the layer has sparse infill, so the left island irons only its fill.
        let pts = solid_points(slice, solid, sparse, Vec::new(), 0.0);
        assert!(fills(&pts, [1.0, 1.0, 9.0, 9.0], 0.06), "{:?}", extents(&pts));
    }

    #[test]
    fn solid_ironing_on_the_first_layer_runs_at_the_first_layer_speed() {
        // The feed of the first ironing line on layer `index` of a solid ironing config for `printer`.
        let feed = |printer: &str, index: u32| {
            let (mut out, areas) = layer();
            out.index = index;
            let mut c = cfg("solid");
            c.raw.insert("ironing_speed".into(), serde_json::json!(40));
            c.raw.insert("printer_model".into(), serde_json::json!(printer));
            c.initial_layer_speed = 27.0;
            c.initial_layer_infill_speed = 33.0;
            assert!(add(&mut out, &areas, &c, false, 0.0, &[]));
            assert!(
                out.paths
                    .iter()
                    .all(|p| (p.speed_mm_s - out.paths[0].speed_mm_s).abs() < 1e-6)
            );
            out.paths[0].speed_mm_s
        };
        assert!((feed("Bambu Lab A1", 0) - 27.0).abs() < 1e-6);
        assert!((feed("Prusa MK4", 0) - 33.0).abs() < 1e-6);
        assert!((feed("Bambu Lab A1", 1) - 40.0).abs() < 1e-6);
        assert!((feed("Prusa MK4", 1) - 40.0).abs() < 1e-6);
    }

    /// The volume per millimeter and the width of the first ironing line of `c` on a layer `h` mm thick, with the
    /// layer height setting at 0.2 mm.
    fn first_line(c: &PrintConfig, h: f32) -> (f64, f64) {
        let (mut out, areas) = layer();
        out.height = h;
        let mut c = c.clone();
        c.layer_height = 0.2;
        assert!(add(&mut out, &areas, &c, false, 0.0, &[]));
        let p = out.paths[0];
        (
            crate::gcode::bead_area(f64::from(p.width_mm), f64::from(h)) * f64::from(p.flow),
            f64::from(p.width_mm),
        )
    }

    #[test]
    fn a_thick_first_layer_irons_at_the_layer_height_setting() {
        // 0.2 x 15% x 0.1 = 0.0030 mm3 per mm on a 0.3 mm layer, not 0.3 x 15% x 0.1 = 0.0045.
        let mut c = cfg("solid");
        c.raw.insert("ironing_flow".into(), serde_json::json!(15));
        c.raw.insert("ironing_spacing".into(), serde_json::json!(0.1));
        let (vol, width) = first_line(&c, 0.3);
        assert!((vol - 0.0030).abs() < 1e-5, "{vol}");
        assert!((width - 0.401_61).abs() < 1e-5, "{width}");
    }

    #[test]
    fn the_filament_ironing_flow_spacing_and_inset_replace_the_process_values() {
        let with = |flow: serde_json::Value, spacing: serde_json::Value, inset: serde_json::Value| {
            let mut c = cfg("top");
            for (k, v) in [
                ("ironing_flow", serde_json::json!(15)),
                ("ironing_spacing", serde_json::json!(0.1)),
                ("ironing_speed", serde_json::json!(40)),
                ("filament_ironing_flow", serde_json::json!([flow])),
                ("filament_ironing_spacing", serde_json::json!([spacing])),
                ("filament_ironing_inset", serde_json::json!([inset])),
                ("filament_ironing_speed", serde_json::json!(["25"])),
            ] {
                c.raw.insert(k.into(), v);
            }
            c
        };
        // The gap between neighboring lines (median), the lowest y ironed and the feed, on the top surface at 0 degrees.
        let lay = |c: &PrintConfig| {
            let (mut out, areas) = layer();
            assert!(add(&mut out, &areas, c, false, 0.0, &[]));
            let mut ys: Vec<f64> = out.points.iter().map(|p| p.y_mm()).collect();
            ys.sort_by(f64::total_cmp);
            ys.dedup_by(|a, b| (*a - *b).abs() < 1e-3);
            let mut gaps: Vec<f64> = ys.windows(2).map(|w| w[1] - w[0]).collect();
            gaps.sort_by(f64::total_cmp);
            (gaps[gaps.len() / 2], ys[0], out.paths[0].speed_mm_s)
        };
        // 0.2 x 40% x 0.25 = 0.0200 mm3 per mm, lines 0.25 apart (a whole number of lines may widen it a little),
        // kept 0.3 inside the outline, at the process speed of 40, not the filament's 25.
        let c = with(
            serde_json::json!("40%"),
            serde_json::json!(0.25),
            serde_json::json!(0.3),
        );
        let (vol, _) = first_line(&c, 0.2);
        assert!((vol - 0.0200).abs() < 1e-5, "{vol}");
        let (gap, low, speed) = lay(&c);
        assert!((0.25..0.3).contains(&gap), "{gap}");
        assert!(low > 0.29, "{low}");
        assert!((speed - 40.0).abs() < 1e-6);
        // `nil` keeps the process values: 0.2 x 15% x 0.1 = 0.0030, lines 0.1 apart, half a nozzle in.
        let nil = with(
            serde_json::json!("nil"),
            serde_json::json!("nil"),
            serde_json::json!("nil"),
        );
        let (vol, _) = first_line(&nil, 0.2);
        assert!((vol - 0.0030).abs() < 1e-5, "{vol}");
        let (gap, low, speed) = lay(&nil);
        assert!((0.1..0.12).contains(&gap), "{gap}");
        assert!(low < 0.26, "{low}");
        assert!((speed - 40.0).abs() < 1e-6);
    }

    #[test]
    fn a_thin_layer_irons_at_the_layer_height_setting() {
        // 0.2 x 25% x 0.15 = 0.0075 mm3 per mm on a 0.1 mm layer, not 0.1 x 25% x 0.15 = 0.00375.
        let mut c = cfg("top");
        c.raw.insert("ironing_flow".into(), serde_json::json!(25));
        c.raw.insert("ironing_spacing".into(), serde_json::json!(0.15));
        let (vol, width) = first_line(&c, 0.1);
        assert!((vol - 0.0075).abs() < 1e-5, "{vol}");
        assert!((width - 0.404_02).abs() < 1e-5, "{width}");
    }

    #[test]
    fn the_speed_is_held_to_the_volumetric_limit_over_the_flow_the_lines_carry() {
        // 0.2 x 15% x 0.15 = 0.0045 mm3 per mm times the filament's flow ratio: at 300 mm/s that is 1.215 to 1.418
        // mm3/s, over a 1.2 mm3/s limit, so the lines slow to exactly the limit.
        let lay = |ratio: f64, cap: f64| {
            let mut c = cfg("top");
            for (k, v) in [
                ("ironing_flow", serde_json::json!("15%")),
                ("ironing_spacing", serde_json::json!(0.15)),
                ("ironing_speed", serde_json::json!(300)),
                ("filament_max_volumetric_speed", serde_json::json!([cap])),
            ] {
                c.raw.insert(k.into(), v);
            }
            c.filament_flow_ratio = vec![ratio];
            let (mut out, areas) = layer();
            assert!(add(&mut out, &areas, &c, false, 0.0, &[]));
            let p = out.paths[0];
            assert!(
                out.paths
                    .iter()
                    .all(|q| q.speed_mm_s.to_bits() == p.speed_mm_s.to_bits())
            );
            let per_mm = crate::gcode::bead_area(f64::from(p.width_mm), 0.2) * f64::from(p.flow) * ratio;
            (f64::from(p.speed_mm_s), per_mm * f64::from(p.speed_mm_s))
        };
        for ratio in [0.9, 0.98, 1.05] {
            let (speed, rate) = lay(ratio, 1.2);
            assert!(speed < 300.0, "{ratio}: {speed}");
            assert!((rate - 1.2).abs() < 1.2e-6, "{ratio}: {rate} mm3/s");
        }
        // A limit the lines stay under leaves the speed alone.
        let (speed, _) = lay(1.05, 50.0);
        assert!((speed - 300.0).abs() < 1e-6, "{speed}");
    }
}
