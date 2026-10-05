// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Custom G-code from the profile: start, end, before and after a layer
//! change, tool change, pause and color change, run through the placeholder
//! language in [`crate::template`] with the variables profiles expect.

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::output::SliceOutput;
use crate::template::{self, Context, Value};
use serde_json::Value as Json;

/// The template stored under `key` (a plain string, or the first entry of a
/// list), when it holds anything.
pub(crate) fn text<'a>(cfg: &'a PrintConfig, key: &str) -> Option<&'a str> {
    let v = cfg.raw.get(key)?;
    let s = match v {
        Json::String(s) => s.as_str(),
        Json::Array(a) => a.first()?.as_str()?,
        _ => return None,
    };
    (!s.trim().is_empty()).then_some(s)
}

fn list(v: impl IntoIterator<Item = f64>) -> Value {
    Value::List(v.into_iter().map(Value::Num).collect())
}

/// The outer wall's volumetric speed, mm3/s: its speed times the bead's cross-section, capped at the
/// limit of the filament in `slot` (Orca: `get_outer_wall_volumetric_speed`).
pub(crate) fn outer_wall_volumetric_speed(cfg: &PrintConfig, slot: u8) -> f64 {
    let h = cfg.layer_height;
    let section = h * (cfg.outer_wall_width() - h * (1.0 - std::f64::consts::FRAC_PI_4));
    let speed = crate::motion::raw_f(cfg, "outer_wall_speed").unwrap_or(60.0);
    (speed * section).min(crate::tower::per_slot_raw(
        cfg,
        "filament_max_volumetric_speed",
        slot,
        15.0,
    ))
}

/// The first filament the print uses and the first that is not a support filament, 0-based (Orca:
/// `ToolOrdering::first_extruder` and `cal_non_support_filaments`); both 0 on an empty plate.
pub(crate) fn first_filaments(cfg: &PrintConfig, out: &SliceOutput) -> (u8, u8) {
    let mut used = out
        .layers
        .iter()
        .flat_map(|l| l.paths.iter().map(|p| p.tool))
        .filter(|&t| t > 0);
    let Some(first) = used.next() else {
        return (0, 0);
    };
    let solid = std::iter::once(first)
        .chain(used)
        .find(|&t| !raw_flag(cfg, "filament_is_support", t))
        .unwrap_or(first);
    (first - 1, solid - 1)
}

/// The bed temperatures of the plate type (`curr_bed_type`) per filament, of the first layer or the others
/// (Orca: `get_bed_temp_1st_layer_key` and `get_bed_temp_key`).
fn plate_temps(cfg: &PrintConfig, first: bool) -> Vec<f64> {
    let plate = match cfg.raw.get("curr_bed_type") {
        Some(Json::String(t)) => crate::preflight::PLATES
            .iter()
            .find(|(n, _)| n == t)
            .map(|(_, k)| *k),
        _ => None,
    }
    .unwrap_or("hot_plate_temp");
    let key = if first {
        format!("{plate}_initial_layer")
    } else {
        plate.to_owned()
    };
    let list: Vec<f64> = match cfg.raw.get(&key) {
        Some(Json::Array(a)) => a
            .iter()
            .filter_map(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
            })
            .collect(),
        Some(v) => v.as_f64().into_iter().collect(),
        None => Vec::new(),
    };
    if list.is_empty() {
        vec![if first {
            cfg.hot_plate_temp_initial_layer
        } else {
            cfg.hot_plate_temp
        }]
    } else {
        list
    }
}

/// `bed_temperature_initial_layer_single`: the first layer's bed temperature of the first filament, or with
/// `bed_temperature_formula` `by_highest_temp` the highest of the filaments the plate prints with.
fn first_bed_single(cfg: &PrintConfig, out: &SliceOutput, first_id: u8) -> f64 {
    let temps = plate_temps(cfg, true);
    let at = |slot: u8| PrintConfig::per_slot(&temps, slot, 0.0);
    if matches!(cfg.raw.get("bed_temperature_formula"), Some(Json::String(f)) if f == "by_highest_temp") {
        let mut used: Vec<u8> = out
            .layers
            .iter()
            .flat_map(|l| l.paths.iter().map(|p| p.tool.max(1)))
            .collect();
        used.sort_unstable();
        used.dedup();
        used.into_iter().map(at).fold(0.0, f64::max)
    } else {
        at(first_id + 1)
    }
}

/// The first layer's extents as Orca's `first_layer_print_min` and `_max` read them, `[min x, min y, max x,
/// max y]`, mm (`Print::_make_skirt` and `finalize_first_layer_convex_hull`): the outlines the skirt goes round,
/// the brim and the prime tower, grown by `skirt_distance` and the skirt's loops as Clipper rounds the hull.
fn first_layer_extents(cfg: &PrintConfig, out: &SliceOutput) -> [f64; 4] {
    let mut pts = out.first_layer_info.skirt_outline.clone();
    // orca's skirt and brim flow: the first layer's width at its height
    let width = cfg.feature_widths.initial_layer.unwrap_or(cfg.line_width);
    let spacing = width - cfg.initial_layer_print_height * (1.0 - std::f64::consts::FRAC_PI_4);
    // the brim's area ends half a spacing past its outer loop
    let brim: Vec<[f64; 2]> = out
        .layers
        .first()
        .filter(|l| l.index == 0)
        .map(|l| {
            l.paths
                .iter()
                .filter(|p| p.feature == crate::output::Feature::Brim)
                .filter_map(|p| l.points.get(p.start as usize..p.end as usize))
                .flatten()
                .map(|q| [q.x_mm(), q.y_mm()])
                .collect()
        })
        .unwrap_or_default();
    pts.extend(round_offset(
        &crate::firmware::convex_hull(brim),
        spacing / 2.0,
        0.0125,
    ));
    // the prime tower's first layer with its brim, as its wall centerlines (`first_layer_wipe_tower_corners`,
    // the corners of the tower's outer walls)
    if out.prime_tower.is_some()
        && let Some(l) = out.layers.first().filter(|l| l.index == 0)
    {
        let tower: Vec<[f64; 2]> = l
            .paths
            .iter()
            .filter(|p| p.feature == crate::output::Feature::PrimeTower)
            .filter_map(|p| l.points.get(p.start as usize..p.end as usize))
            .flatten()
            .map(|q| [q.x_mm(), q.y_mm()])
            .collect();
        let bounds = tower.iter().fold(None::<[f64; 4]>, |b, p| {
            Some(b.map_or([p[0], p[1], p[0], p[1]], |b| {
                [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
            }))
        });
        if let Some(b) = bounds {
            pts.extend([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]);
        }
    }
    let shield = cfg.skirt_loops > 0
        && matches!(cfg.raw.get("draft_shield"), Some(serde_json::Value::String(t)) if t == "enabled");
    if cfg.skirt_height > 0 || shield {
        // the skirt's hull: the loops' centerline plus half a spacing, in orca's single precision
        #[allow(
            clippy::cast_possible_truncation,
            reason = "orca works the distance out in floats"
        )]
        let reach = {
            let step = (f64::from(spacing as f32) / 1e-6) as f32;
            let mut d = ((cfg.skirt_distance - f64::from(spacing as f32) / 2.0) / 1e-6) as f32;
            for _ in 0..cfg.skirt_loops {
                d += step;
            }
            f64::from(d + 0.5 * step) * 1e-6
        };
        pts = round_offset(&crate::firmware::convex_hull(pts), reach, 0.1);
    }
    if pts.is_empty() {
        return out.plate_bounds.map(f64::from);
    }
    pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
        [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
    })
}

/// The points of Clipper's round offset of a counterclockwise convex polygon by `delta` mm, arcs to `tolerance`
/// mm, on Orca's nanometer grid (`ClipperOffset::DoOffset`, `OffsetPoint` and `DoRound`, with Orca's
/// `ClipperOffsetShortestEdgeFactor`). The polygon itself when there is nothing to grow.
fn round_offset(poly: &[[f64; 2]], delta: f64, tolerance: f64) -> Vec<[f64; 2]> {
    const NM: f64 = 1e6;
    let d = (delta * NM).round();
    if poly.len() < 3 || d < 1.0 {
        return poly.to_vec();
    }
    // points closer than 0.005 of the offset merge
    let shortest = (d * 0.005).m_powi(2);
    let near = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).m_powi(2) + (a[1] - b[1]).m_powi(2) < shortest;
    let mut src: Vec<[f64; 2]> = Vec::with_capacity(poly.len());
    for p in poly {
        let q = [(p[0] * NM).round(), (p[1] * NM).round()];
        if src.last().is_none_or(|&l| !near(l, q)) {
            src.push(q);
        }
    }
    while src.len() > 1 && src.first().zip(src.last()).is_some_and(|(&a, &b)| near(a, b)) {
        src.pop();
    }
    let n = src.len();
    if n < 3 {
        return poly.to_vec();
    }
    let y = (tolerance * NM).min(d * 0.25);
    let steps = (std::f64::consts::PI / (1.0 - y / d).m_acos()).min(d * std::f64::consts::PI);
    let (sin, cos) = (std::f64::consts::TAU / steps).m_sin_cos();
    let per_rad = steps / std::f64::consts::TAU;
    // the outward normal of each edge, from its point to the next
    let normals: Vec<[f64; 2]> = src
        .iter()
        .zip(src.iter().cycle().skip(1))
        .map(|(a, b)| {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let len = dx.m_hypot(dy);
            if len == 0.0 {
                [0.0, 0.0]
            } else {
                [dy / len, -dx / len]
            }
        })
        .collect();
    let mut out = Vec::with_capacity(n * 4);
    let mut put =
        |p: [f64; 2], v: [f64; 2]| out.push([(p[0] + v[0] * d).round() / NM, (p[1] + v[1] * d).round() / NM]);
    // each point with its edge's normal and the one before
    for ((&p, &nj), &nk) in src.iter().zip(&normals).zip(normals.iter().cycle().skip(n - 1)) {
        let dot = nk[0] * nj[0] + nk[1] * nj[1];
        let mut sin_a = nk[0] * nj[1] - nj[0] * nk[1];
        if (sin_a * d).abs() < 1.0 {
            if dot > 0.0 {
                put(p, nk);
                continue;
            }
        } else {
            sin_a = sin_a.clamp(-1.0, 1.0);
        }
        if sin_a * d < 0.0 {
            put(p, nk);
            put(p, [0.0, 0.0]);
            put(p, nj);
            continue;
        }
        #[allow(clippy::cast_possible_truncation, reason = "a small step count")]
        let count = ((per_rad * sin_a.m_atan2(dot).abs()).round() as i64).max(1);
        let mut v = nk;
        for _ in 0..count {
            put(p, v);
            v = [v[0] * cos - sin * v[1], v[0] * sin + v[1] * cos];
        }
        put(p, nj);
    }
    out
}

/// Orca's adaptive bed mesh (`GCode::_do_export`): the first layer's extents grown by `adaptive_bed_mesh_margin`
/// within `bed_mesh_min` and `bed_mesh_max`, probe points `bed_mesh_probe_distance` apart (at least 3 a side),
/// and `lagrange` for 6 points or fewer, else `bicubic` (with 4 a side on Klipper).
fn bed_mesh(cfg: &PrintConfig, b: [f64; 4]) -> ([f64; 2], [f64; 2], [f64; 2], &'static str) {
    let point = |key: &str, fallback: [f64; 2]| -> [f64; 2] {
        let nums: Vec<f64> = match cfg.raw.get(key) {
            Some(Json::Array(a)) => a
                .iter()
                .filter_map(|v| {
                    v.as_f64()
                        .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
                })
                .collect(),
            Some(Json::String(t)) => t
                .split(['x', ','])
                .filter_map(|v| v.trim().parse().ok())
                .collect(),
            _ => Vec::new(),
        };
        match nums.as_slice() {
            [x, y, ..] => [*x, *y],
            _ => fallback,
        }
    };
    let (lo, hi) = (
        point("bed_mesh_min", [-99999.0; 2]),
        point("bed_mesh_max", [99999.0; 2]),
    );
    let margin = cfg.raw_number("adaptive_bed_mesh_margin", 0.0);
    let min = [lo[0].max(b[0] - margin), lo[1].max(b[1] - margin)];
    let max = [hi[0].min(b[2] + margin), hi[1].min(b[3] + margin)];
    let dist = point("bed_mesh_probe_distance", [50.0, 50.0]);
    let count = |lo: f64, hi: f64, step: f64| ((hi - lo) / step.max(1.0)).ceil().max(2.0) + 1.0;
    let (mut x, mut y) = (count(min[0], max[0], dist[0]), count(min[1], max[1], dist[1]));
    let algo = if x * y <= 6.0 { "lagrange" } else { "bicubic" };
    if algo == "bicubic" && cfg.gcode_flavor == crate::config::GcodeFlavor::Klipper {
        (x, y) = (x.max(4.0), y.max(4.0));
    }
    (min, max, [x, y], algo)
}

/// A list of points setting (`"30x-3"` texts, `[x, y]` pairs, or one text of them joined by commas), mm.
fn points(cfg: &PrintConfig, key: &str) -> Vec<[f64; 2]> {
    let pair = |t: &str| {
        let (x, y) = t.trim().split_once('x')?;
        Some([x.trim().parse().ok()?, y.trim().parse().ok()?])
    };
    match cfg.raw.get(key) {
        Some(Json::Array(a)) => a
            .iter()
            .filter_map(|v| match v {
                Json::String(t) => pair(t),
                Json::Array(xy) => Some([xy.first()?.as_f64()?, xy.get(1)?.as_f64()?]),
                _ => None,
            })
            .collect(),
        Some(Json::String(t)) => t.split(',').filter_map(pair).collect(),
        _ => Vec::new(),
    }
}

/// Where a bambu printer travels to cut and change filament past the objects (Orca's
/// `get_path_of_change_filament`): from `start_end_points` round the cutter area (`bed_exclude_area`), along a
/// free strip of x between the objects.
fn change_filament_path(cfg: &PrintConfig, out: &SliceOutput) -> [[f64; 2]; 3] {
    let fallback = [[54.0, 0.0], [54.0, 0.0], [54.0, 245.0]];
    let (ends, cutter) = (points(cfg, "start_end_points"), points(cfg, "bed_exclude_area"));
    let ([start, end], Some(corner)) = (ends.as_slice(), cutter.get(2)) else {
        return fallback;
    };
    let (start_x, end_x, end_y) = (start[0], end[0], end[1]);
    let cutter_y = corner[1] + 2.0;
    let mut from_left = true;
    // the x ranges the objects take, 2 mm wide of them, merged where they meet
    let mut taken: Vec<(f64, f64)> = Vec::new();
    for o in &out.objects {
        let (lo_x, lo_y) = o
            .hull
            .iter()
            .fold((f64::MAX, f64::MAX), |m, p| (m.0.min(p[0]), m.1.min(p[1])));
        let hi_x = o.hull.iter().fold(f64::MIN, |m, p| m.max(p[0]));
        if lo_x < start_x && lo_y < cutter_y {
            from_left = false;
        }
        let mut span = (lo_x - 2.0, hi_x + 2.0);
        let (meet, apart): (Vec<_>, Vec<_>) = taken.into_iter().partition(|t| t.1 >= span.0 && t.0 <= span.1);
        for t in meet {
            span = (span.0.min(t.0), span.1.max(t.1));
        }
        taken = apart;
        taken.push(span);
    }
    crate::sorting::sort_by(&mut taken, |a, b| a.0.total_cmp(&b.0));
    let mut free = Vec::new();
    let mut at = 0.0;
    for t in &taken {
        if t.0 > at {
            free.push((at, t.0));
        }
        at = t.1;
    }
    free.push((at, 255.0));
    // the free strip nearest the end point
    let mut path = 255.0;
    for f in free {
        if f.0 > end_x {
            path = if (end_x - path).abs() < f.0 - end_x {
                path
            } else {
                f.0
            };
            break;
        } else if f.1 >= end_x {
            path = end_x;
            break;
        } else if !from_left && f.1 < start_x {
            continue;
        }
        path = f.1;
    }
    if path < start_x {
        [[start_x, cutter_y], [path, cutter_y], [path, end_y]]
    } else {
        [[path, 0.0], [path, 0.0], [path, end_y]]
    }
}

/// The variables of a print: settings the core parses, then the plate.
pub(crate) fn context<'a>(cfg: &'a PrintConfig, out: &SliceOutput) -> Context<'a> {
    // the start loads the first filament that is not support; `[name]` reads the first filament's entry
    let (first_id, solid_id) = first_filaments(cfg, out);
    let mut c = Context {
        config: Some(&cfg.raw),
        extruder: usize::from(first_id),
        ..Context::default()
    };
    let tools = usize::from(out.tool_count.max(1));
    let tool_count_f = f64::from(out.tool_count.max(1));
    let per = |f: &dyn Fn(u8) -> f64| list((1..=out.tool_count.max(1)).map(f));
    let n = |v: f64| Value::Num(v);
    let bed = cfg.bed_rect();
    let first_temp = per(&|s| {
        if cfg.nozzle_temperature_initial_layer.is_empty() {
            PrintConfig::per_slot(&cfg.nozzle_temperature, s, 220.0)
        } else {
            PrintConfig::per_slot(&cfg.nozzle_temperature_initial_layer, s, 220.0)
        }
    });
    let first_bed = if cfg.hot_plate_temp_initial_layer > 0.0 {
        cfg.hot_plate_temp_initial_layer
    } else {
        cfg.hot_plate_temp
    };
    let volume_type = match cfg.raw.get("nozzle_volume_type") {
        Some(serde_json::Value::Array(a)) => a
            .first()
            .and_then(|v| v.as_str())
            .unwrap_or("Standard")
            .to_owned(),
        Some(serde_json::Value::String(t)) => t.clone(),
        _ => "Standard".to_owned(),
    };
    // An extruder with several nozzles (the H2C's right one holds six) makes the hotend ids -1, as in Orca.
    let multi_nozzle = match cfg.raw.get("extruder_max_nozzle_count") {
        Some(serde_json::Value::Array(a))
            if a.iter().any(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|t| t.parse().ok()))
                    .is_some_and(|n| n > 1.0)
            }) =>
        {
            -1.0
        }
        _ if cfg.raw_number("extruder_max_nozzle_count", 1.0) > 1.0 => -1.0,
        _ => 0.0,
    };
    // Orca GCode.cpp (`wipe_tower_center_pos_*`): beside the tower on the side of the bed's middle, clamped to the bed.
    let tower_center = out.prime_tower.as_ref().map(|t| {
        let x = if t.x + t.width / 2.0 < f64::midpoint(bed[0], bed[2]) {
            t.x + t.width + 2.0
        } else {
            t.x - 2.0
        };
        [x.clamp(bed[0], bed[2]), t.y + t.depth / 2.0]
    });
    let b = first_layer_extents(cfg, out);
    // orca works the change path out only for a print on several filaments; zero otherwise
    let travel = if out.tool_count > 1 {
        change_filament_path(cfg, out)
    } else {
        [[0.0; 2]; 3]
    };
    let (mesh_min, mesh_max, probes, algo) = bed_mesh(cfg, b);
    let vars = [
        ("layer_height", n(cfg.layer_height)),
        ("first_layer_height", n(cfg.initial_layer_print_height)),
        ("initial_layer_print_height", n(cfg.initial_layer_print_height)),
        ("printable_height", n(cfg.printable_height)),
        ("max_print_height", n(cfg.printable_height)),
        (
            "nozzle_diameter",
            list(std::iter::repeat_n(cfg.nozzle_diameter, tools)),
        ),
        (
            "temperature",
            per(&|s| PrintConfig::per_slot(&cfg.nozzle_temperature, s, 220.0)),
        ),
        (
            "nozzle_temperature",
            per(&|s| PrintConfig::per_slot(&cfg.nozzle_temperature, s, 220.0)),
        ),
        ("first_layer_temperature", first_temp.clone()),
        ("nozzle_temperature_initial_layer", first_temp),
        ("bed_temperature", list(plate_temps(cfg, false))),
        ("hot_plate_temp", list([cfg.hot_plate_temp])),
        ("first_layer_bed_temperature", list(plate_temps(cfg, true))),
        ("hot_plate_temp_initial_layer", list([first_bed])),
        ("bed_temperature_initial_layer", list(plate_temps(cfg, true))),
        (
            "bed_temperature_initial_layer_single",
            n(first_bed_single(cfg, out, first_id)),
        ),
        ("retraction_length", per(&|s| cfg.filament_retraction_length(s))),
        ("retract_length", per(&|s| cfg.filament_retraction_length(s))),
        ("retraction_speed", n(cfg.retraction_speed)),
        ("travel_speed", n(cfg.travel_speed)),
        ("z_offset", n(0.0)),
        ("print_bed_min", list([bed[0], bed[1]])),
        ("print_bed_max", list([bed[2], bed[3]])),
        ("print_bed_size", list([bed[2] - bed[0], bed[3] - bed[1]])),
        ("first_layer_print_min", list([b[0], b[1]])),
        ("first_layer_print_max", list([b[2], b[3]])),
        ("first_layer_print_size", list([b[2] - b[0], b[3] - b[1]])),
        ("travel_point_1_x", n(travel[0][0])),
        ("travel_point_1_y", n(travel[0][1])),
        ("travel_point_2_x", n(travel[1][0])),
        ("travel_point_2_y", n(travel[1][1])),
        ("travel_point_3_x", n(travel[2][0])),
        ("travel_point_3_y", n(travel[2][1])),
        ("adaptive_bed_mesh_min", list(mesh_min)),
        ("adaptive_bed_mesh_max", list(mesh_max)),
        ("bed_mesh_probe_count", list(probes)),
        ("bed_mesh_algo", Value::Str(algo.to_owned())),
        // What the flush uses: a filament's own flush speed and temperature, else its printing limits.
        (
            "flush_volumetric_speeds",
            per(&|s| {
                let own = crate::tower::per_slot_raw(cfg, "filament_flush_volumetric_speed", s, 0.0);
                if own > 0.0 {
                    own
                } else {
                    crate::tower::per_slot_raw(cfg, "filament_max_volumetric_speed", s, 15.0)
                }
            }),
        ),
        (
            "flush_temperatures",
            per(&|s| {
                let own = crate::tower::per_slot_raw(cfg, "filament_flush_temp", s, 0.0);
                if own > 0.0 {
                    own
                } else {
                    crate::tower::per_slot_raw(cfg, "nozzle_temperature_range_high", s, 240.0)
                }
            }),
        ),
        ("flush_length_2", n(0.0)),
        ("flush_length_3", n(0.0)),
        ("flush_length_4", n(0.0)),
        (
            "outer_wall_volumetric_speed",
            n(outer_wall_volumetric_speed(cfg, solid_id + 1)),
        ),
        (
            "during_print_exhaust_fan_speed_num",
            list((1..=out.tool_count.max(1)).map(|s| {
                (crate::tower::per_slot_raw(cfg, "during_print_exhaust_fan_speed", s, 0.0) / 100.0 * 255.0)
                    .trunc()
            })),
        ),
        ("total_layer_count", n(f64::from(out.layer_count))),
        ("max_layer_z", n(f64::from(out.plate_top_z))),
        ("num_extruders", n(tool_count_f)),
        ("initial_extruder", n(f64::from(first_id))),
        ("initial_tool", n(f64::from(first_id))),
        ("filament_extruder_id", n(f64::from(solid_id))),
        ("initial_no_support_extruder", n(f64::from(solid_id))),
        ("initial_no_support_tool", n(f64::from(solid_id))),
        ("current_extruder", n(f64::from(first_id))),
        ("previous_extruder", n(0.0)),
        ("next_extruder", n(0.0)),
        // Newer Orca names: the filament (0-based) in the nozzle, the next one at a tool change, the height of the
        // tool change, and whether a time lapse frame is taken in place (GCode.cpp).
        ("current_filament_id", n(f64::from(first_id))),
        ("next_filament_id", n(0.0)),
        ("toolchange_z", n(0.0)),
        ("timelapse_inline_photo", Value::Bool(false)),
        ("farthest_point_timelapse_enabled", Value::Bool(false)),
        ("initial_filament_id", n(f64::from(first_id))),
        ("initial_no_support_filament_id", n(f64::from(solid_id))),
        // Nozzles and hotends: one nozzle in one hotend here. Orca gives the H2C's several-nozzle hotend -1.
        ("current_hotend", n(multi_nozzle)),
        ("next_hotend", n(multi_nozzle)),
        ("initial_no_support_hotend", n(multi_nozzle)),
        ("current_nozzle_id", n(0.0)),
        ("next_nozzle_id", n(0.0)),
        ("initial_nozzle_id", n(0.0)),
        ("nozzle_diameter_at_nozzle_id", list([cfg.nozzle_diameter])),
        ("nozzle_volume_types", Value::List(vec![Value::Str(volume_type)])),
        ("is_prime_tower_interface", Value::Bool(false)),
        ("new_extruder_retracted_length", n(0.0)),
        // Where the nozzle heats beside the tower: 2 mm off its side toward the middle of the bed, at its middle in Y.
        ("wipe_tower_center_pos_x", n(tower_center.map_or(0.0, |c| c[0]))),
        ("wipe_tower_center_pos_y", n(tower_center.map_or(0.0, |c| c[1]))),
        ("wipe_tower_center_pos_valid", Value::Bool(tower_center.is_some())),
        ("total_toolchanges", n(0.0)),
        ("extruded_weight_total", n(0.0)),
        ("e_retracted", list(std::iter::repeat_n(0.0, tools))),
        ("position", list([0.0, 0.0, 0.0])),
        ("has_wipe_tower", Value::Bool(false)),
        // i3 timelapse and head wrap templates skip their moves to the bed edge when printing by object
        (
            "print_sequence",
            Value::Str(
                if cfg.print_by_object() {
                    "by object"
                } else {
                    "by layer"
                }
                .into(),
            ),
        ),
        ("fan_max_speed", list([cfg.fan_max_speed])),
        ("fan_min_speed", list([cfg.fan_min_speed])),
        (
            "close_fan_the_first_x_layers",
            list([f64::from(cfg.close_fan_the_first_x_layers)]),
        ),
    ];
    for (k, v) in vars {
        c.vars.insert(k.to_owned(), v);
    }
    // Every extruder a print might use, with the ones on this plate marked.
    c.vars.insert(
        "is_extruder_used".to_owned(),
        Value::List((0..64).map(|i| Value::Bool(i < tools)).collect()),
    );
    plate_vars(&mut c, cfg, out, tools, out.plate_bounds.map(f64::from));
    add_defaults(&mut c, cfg, tools);
    for (k, default) in [
        ("plate_name", ""),
        ("curr_bed_type", "Textured PEI Plate"),
        ("printer_notes", ""),
        ("timelapse_type", "0"),
    ] {
        if !cfg.raw.contains_key(k) {
            c.vars.insert(k.to_owned(), Value::Str(default.to_owned()));
        }
    }
    c
}

/// Renders the template under `key`, or None when the profile has none.
pub(crate) fn render(cfg: &PrintConfig, ctx: &Context<'_>, key: &str) -> Result<Option<String>, String> {
    let Some(t) = text(cfg, key) else { return Ok(None) };
    let rendered = template::render(t, ctx).map_err(|e| format!("{key}: {e}"))?;
    vet(section_of(key), &rendered, cfg)?;
    Ok(Some(rendered))
}

/// Renders the entry of a per-filament template (`filament_start_gcode`, `filament_end_gcode`) for a 1-based slot.
pub(crate) fn render_slot(
    cfg: &PrintConfig,
    ctx: &Context<'_>,
    key: &str,
    slot: u8,
) -> Result<Option<String>, String> {
    let Some(t) = raw_text(cfg, key, slot).filter(|t| !t.trim().is_empty()) else {
        return Ok(None);
    };
    let rendered = template::render(&t, ctx).map_err(|e| format!("{key}: {e}"))?;
    vet(section_of(key), &rendered, cfg)?;
    Ok(Some(rendered))
}

/// Where in the file a custom G-code key sits, which decides what the linter allows.
fn section_of(key: &str) -> crate::gcode_lint::Section {
    use crate::gcode_lint::Section;
    match key {
        "machine_start_gcode" | "filament_start_gcode" => Section::Start,
        // The filament end hook runs when the filament is swapped, not when the print is over.
        "machine_end_gcode" => Section::End,
        "before_layer_change_gcode" | "layer_change_gcode" => Section::LayerChange,
        "change_filament_gcode" | "toolchange_gcode" => Section::ToolChange,
        "machine_pause_gcode" | "color_change_gcode" | "template_custom_gcode" => Section::Pause,
        _ => Section::Other,
    }
}

/// Runs the G-code linter over rendered text. A finding that blocks is reported as
/// `safety: ...`, which the writer turns into a blocked slice.
fn vet(section: crate::gcode_lint::Section, text: &str, cfg: &PrintConfig) -> Result<(), String> {
    crate::preflight::vet_custom(section, text, cfg).map_err(|e| format!("safety: {e}"))
}

/// Renders `template` (given directly, such as a pause command from a request).
pub(crate) fn render_text(t: &str, ctx: &Context<'_>, what: &str) -> Result<String, String> {
    let rendered = template::render(t, ctx).map_err(|e| format!("{what}: {e}"))?;
    // Text from a request is never the person's own settings, so it is linted as untrusted.
    // (The default settings treat custom G-code as untrusted.)
    vet(
        crate::gcode_lint::Section::LayerChange,
        &rendered,
        &PrintConfig::default(),
    )?;
    Ok(rendered)
}

/// The extrusion role change hooks, in the order Orca writes them (`GCode::_extrude`): the printer's, the
/// filament's and the process's.
const ROLE_HOOKS: [&str; 3] = [
    "change_extrusion_role_gcode",
    "filament_change_extrusion_role_gcode",
    "process_change_extrusion_role_gcode",
];

/// Whether the profile has any extrusion role change G-code.
pub(crate) fn role_hooks(cfg: &PrintConfig) -> bool {
    ROLE_HOOKS.iter().any(|k| match cfg.raw.get(*k) {
        Some(Json::String(t)) => !t.trim().is_empty(),
        Some(Json::Array(a)) => a.iter().any(|v| v.as_str().is_some_and(|t| !t.trim().is_empty())),
        _ => false,
    })
}

/// Orca's name of a feature in the role change G-code (`extrusion_role_to_string_for_parser`).
pub(crate) fn role_name(f: Option<crate::output::Feature>) -> &'static str {
    use crate::output::Feature;
    match f {
        Some(Feature::OuterWall) => "ExternalPerimeter",
        Some(Feature::InnerWall) => "Perimeter",
        Some(Feature::OverhangWall) => "OverhangPerimeter",
        Some(Feature::TopSurface) => "TopSolidInfill",
        Some(Feature::BottomSurface) => "BottomSurface",
        Some(Feature::InternalSolid) => "SolidInfill",
        Some(Feature::SparseInfill) => "InternalInfill",
        Some(Feature::Bridge | Feature::InternalBridge) => "BridgeInfill",
        Some(Feature::GapFill) => "GapFill",
        Some(Feature::Ironing) => "Ironing",
        Some(Feature::Skirt) => "Skirt",
        Some(Feature::Brim) => "Brim",
        Some(Feature::Support) => "SupportMaterial",
        Some(Feature::SupportInterface) => "SupportMaterialInterface",
        Some(Feature::PrimeTower) => "WipeTower",
        Some(Feature::Custom) | None => "Mixed",
    }
}

/// The role change G-code before the first line of `role` (Orca `GCode::_extrude`): each hook rendered with
/// `extrusion_role`, `last_extrusion_role`, `layer_num` (1-based) and `layer_z`, the filament's for `slot`,
/// each followed by a newline.
pub(crate) fn role_change(
    cfg: &PrintConfig,
    ctx: &mut Context<'_>,
    slot: u8,
    role: crate::output::Feature,
    last: Option<crate::output::Feature>,
    layer_num: u32,
    layer_z: f64,
) -> Result<String, String> {
    ctx.vars.insert(
        "extrusion_role".to_owned(),
        Value::Str(role_name(Some(role)).to_owned()),
    );
    ctx.vars.insert(
        "last_extrusion_role".to_owned(),
        Value::Str(role_name(last).to_owned()),
    );
    ctx.set_num("layer_num", f64::from(layer_num));
    ctx.set_num("layer_z", layer_z);
    ctx.extruder = usize::from(slot.max(1) - 1);
    let mut out = String::new();
    for key in ROLE_HOOKS {
        let Some(t) = raw_text(cfg, key, slot).filter(|t| !t.trim().is_empty()) else {
            continue;
        };
        let rendered = template::render(&t, ctx).map_err(|e| format!("{key}: {e}"))?;
        vet(section_of(key), &rendered, cfg)?;
        out.push_str(&rendered);
        out.push('\n');
    }
    Ok(out)
}

/// The text of a per-filament setting for a slot (a list entry, or a lone value).
fn raw_text(cfg: &PrintConfig, key: &str, slot: u8) -> Option<String> {
    let text = |v: &serde_json::Value| match v {
        serde_json::Value::String(t) => Some(t.clone()),
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

/// The `filament_type` of a slot, as orca names the material in the tower's change comment.
pub(crate) fn filament_type(cfg: &PrintConfig, slot: u8) -> String {
    raw_text(cfg, "filament_type", slot).unwrap_or_else(|| "PLA".to_owned())
}

/// A true/false entry of a per-filament list for a slot.
fn raw_flag(cfg: &PrintConfig, key: &str, slot: u8) -> bool {
    let flag = |v: &serde_json::Value| match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(t) => t == "1" || t.eq_ignore_ascii_case("true"),
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        _ => false,
    };
    match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a
            .get(usize::from(slot.max(1) - 1))
            .or_else(|| a.last())
            .is_some_and(flag),
        Some(v) => flag(v),
        None => false,
    }
}

/// Calendar fields of the moment of slicing: `options.nowUnix` with its offset when the host sends it, else the
/// system clock in UTC (WASM has no clock and reads 1970).
pub(crate) fn calendar(cfg: &PrintConfig) -> [f64; 6] {
    #[cfg(not(target_arch = "wasm32"))]
    let clock = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0));
    #[cfg(target_arch = "wasm32")]
    let clock = 0i64;
    let secs = match cfg.now {
        Some((t, offset)) => t + i64::from(offset) * 60,
        None => clock,
    };
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    #[allow(clippy::cast_precision_loss, reason = "calendar fields are small")]
    [year, month, day, rem / 3600, rem % 3600 / 60, rem % 60].map(|v| v as f64)
}

/// Variables Orca's `GCode::_do_export` sets from the plate and the print (`GCode.cpp`, the block that
/// fills `placeholder_parser` before the start G-code): retraction on cut and on filament change, the
/// first filaments, the chamber and the first layer's extents, the calendar. A key the profile itself
/// has wins over these.
fn plate_vars(c: &mut Context<'_>, cfg: &PrintConfig, out: &SliceOutput, tools: usize, first: [f64; 4]) {
    let slots = 1..=out.tool_count.max(1);
    let n = Value::Num;
    let put = |c: &mut Context<'_>, k: &str, v: Value| {
        if !cfg.raw.contains_key(k) {
            c.vars.insert(k.to_owned(), v);
        }
    };
    let list = |f: &dyn Fn(u8) -> Value| Value::List(slots.clone().map(f).collect());
    // Retraction on cut and on filament change: the lists, and the first filament's entry.
    // With `enable_long_retraction_when_cut` at 2 each filament's own value (`filament_` prefix, when
    // not nil) overrides the printer's (Orca's `compute_filament_override_value`).
    let by_filament = (cfg.raw_number("enable_long_retraction_when_cut", 0.0) - 2.0).abs() < 0.5;
    let own = |key: &str, s: u8| -> Option<serde_json::Value> {
        if !by_filament || !key.ends_with("_when_cut") {
            return None;
        }
        let v = match cfg.raw.get(&format!("filament_{key}"))? {
            serde_json::Value::Array(a) => a.get(usize::from(s.max(1) - 1)).or_else(|| a.last())?.clone(),
            v => v.clone(),
        };
        (!matches!(&v, serde_json::Value::String(t) if t == "nil" || t.is_empty()) && !v.is_null())
            .then_some(v)
    };
    let num = |v: &serde_json::Value| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
    };
    for (key, default) in [
        ("retraction_distances_when_cut", 18.0),
        ("retraction_distances_when_ec", 10.0),
    ] {
        let at = |s: u8| {
            own(key, s)
                .as_ref()
                .and_then(num)
                .unwrap_or_else(|| crate::tower::per_slot_raw(cfg, key, s, default))
        };
        let one = key.replace("distances", "distance");
        if by_filament && key.ends_with("_when_cut") {
            // The resolved per filament values replace the printer's list.
            c.vars.insert(key.to_owned(), list(&|s| n(at(s))));
            c.vars.insert(one, n(at(1)));
            continue;
        }
        put(c, key, list(&|s| n(at(s))));
        put(c, &one, n(at(1)));
    }
    for key in ["long_retractions_when_cut", "long_retractions_when_ec"] {
        let at = |s: u8| {
            own(key, s).map_or_else(
                || raw_flag(cfg, key, s),
                |v| num(&v).is_some_and(|x| x != 0.0) || v.as_bool() == Some(true),
            )
        };
        if by_filament && key.ends_with("_when_cut") {
            c.vars.insert(key.to_owned(), list(&|s| Value::Bool(at(s))));
            c.vars
                .insert(key.replace("retractions", "retraction"), Value::Bool(at(1)));
            continue;
        }
        put(c, key, list(&|s| Value::Bool(at(s))));
        put(c, &key.replace("retractions", "retraction"), Value::Bool(at(1)));
    }
    // Filament to physical extruder maps: one nozzle, every filament in it.
    put(c, "filament_map", list(&|_| n(1.0)));
    put(c, "physical_extruder_map", list(&|_| n(0.0)));
    // `first_non_support_hotend`: the hotend of the first filament that is not support; one nozzle here, so 0.
    for k in [
        "first_filaments",
        "first_tools",
        "first_non_support_filaments",
        "first_non_support_tools",
        "first_non_support_hotend",
    ] {
        put(c, k, Value::List(vec![n(0.0)]));
    }
    for k in ["most_used_physical_extruder_id", "curr_physical_extruder_id"] {
        put(c, k, n(0.0));
    }
    let used: Vec<u8> = slots.clone().collect();
    put(
        c,
        "has_tpu_in_first_layer",
        Value::Bool(
            used.iter()
                .any(|&s| raw_text(cfg, "filament_type", s).is_some_and(|t| t == "TPU")),
        ),
    );
    put(
        c,
        "is_all_bbl_filament",
        Value::Bool(
            used.iter()
                .all(|&s| raw_text(cfg, "filament_vendor", s).is_some_and(|t| t == "Bambu Lab")),
        ),
    );
    let chamber = slots
        .clone()
        .map(|s| crate::tower::per_slot_raw(cfg, "chamber_temperature", s, 0.0))
        .fold(0.0, f64::max);
    put(c, "overall_chamber_temperature", n(chamber.trunc()));
    let vitrification = slots
        .clone()
        .map(|s| crate::tower::per_slot_raw(cfg, "temperature_vitrification", s, 100.0))
        .fold(f64::MAX, f64::min);
    put(c, "min_vitrification_temperature", n(vitrification.trunc()));
    let extra_fan = slots
        .clone()
        .map(|s| crate::tower::per_slot_raw(cfg, "additional_cooling_fan_speed", s, 0.0))
        .fold(0.0, f64::max);
    put(c, "max_additional_fan", n(extra_fan));
    put(c, "max_print_z", n(f64::from(out.plate_top_z).ceil()));
    // A flat, wide print holds the chamber temperature: lower than 0.3 mm and over 400 mm2 (Orca sums the
    // first layer's islands, brim and tower; its constant is 40000 against areas in 1e-12 mm2 units
    // scaled by 1e10, so the threshold is 400 mm2). Supports are not summed here.
    put(
        c,
        "hold_chamber_temp_for_flat_print",
        Value::Bool(
            out.plate_top_z > 0.0
                && f64::from(out.plate_top_z) < 0.3
                && f64::from(out.first_layer_info.area_mm2) > 400.0,
        ),
    );
    put(
        c,
        "first_layer_center_no_wipe_tower",
        Value::List(vec![
            n(f64::midpoint(first[0], first[2])),
            n(f64::midpoint(first[1], first[3])),
        ]),
    );
    // The head wrap detection zone, as a box over the zone's corners; none given means no overlap.
    let zone: Vec<[f64; 2]> = match cfg.raw.get("head_wrap_detect_zone") {
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|p| {
                let xy: Vec<f64> = match p {
                    serde_json::Value::Array(v) => v.iter().filter_map(serde_json::Value::as_f64).collect(),
                    serde_json::Value::String(t) => {
                        t.split('x').filter_map(|v| v.trim().parse().ok()).collect()
                    }
                    _ => Vec::new(),
                };
                Some([*xy.first()?, *xy.get(1)?])
            })
            .collect(),
        _ => Vec::new(),
    };
    let hit = zone.len() >= 3 && {
        // The first layer's outlines against the zone polygon (Orca: `intersection_pl`, whether any part of
        // the layer's projection crosses or lies inside the zone).
        let ring = |p: &[[f64; 2]]| -> Vec<i_overlay::i_float::int::point::IntPoint<i32>> {
            p.iter()
                .map(|q| {
                    let pt = crate::geom::Point::from_mm(q[0], q[1]);
                    i_overlay::i_float::int::point::IntPoint::new(pt.x, pt.y)
                })
                .collect()
        };
        let zone_shape: crate::perimeters::Shapes = vec![vec![ring(&zone)]];
        let layer: crate::perimeters::Shapes = out
            .first_layer_info
            .rings
            .iter()
            .map(|r| {
                vec![ring(
                    &r.iter()
                        .map(|q| [f64::from(q[0]), f64::from(q[1])])
                        .collect::<Vec<_>>(),
                )]
            })
            .collect();
        let layer = crate::perimeters::union_all(&[&layer]);
        !crate::perimeters::intersection(&layer, &zone_shape).is_empty()
    };
    put(c, "in_head_wrap_detect_zone", Value::Bool(hit));
    // Timelapse safe position: none picked, so the default (0, 0).
    put(c, "timelapse_pos_x", n(0.0));
    put(c, "timelapse_pos_y", n(0.0));
    put(c, "has_timelapse_safe_pos", Value::Bool(false));
    // Wipe tower avoidance: no tower, so the default x Orca uses.
    put(c, "wipe_avoid_perimeter", Value::Bool(false));
    put(c, "wipe_avoid_pos_x", n(110.0));
    // Numbers the finished file knows: written as marks that `firmware::finalize` replaces.
    put(
        c,
        "print_time_sec",
        Value::Str(crate::firmware::TIME_MARK.to_owned()),
    );
    put(
        c,
        "used_filament_length",
        Value::Str(crate::firmware::LENGTH_MARK.to_owned()),
    );
    for (k, v) in ["year", "month", "day", "hour", "minute", "second"]
        .iter()
        .zip(calendar(cfg))
    {
        put(c, k, n(v));
    }
    let _ = tools;
}

/// Variables of printers and firmware that profiles read and that a plain print has no
/// value for: tool change positions, wipe tower flush lengths, preset names, motion
/// limits. A key the profile itself has wins over these.
fn add_defaults(c: &mut Context<'_>, cfg: &PrintConfig, tools: usize) {
    let zero = || Value::Num(0.0);
    let first_temp = c
        .vars
        .get("first_layer_temperature")
        .cloned()
        .unwrap_or_else(zero);
    let (min, max) = (
        c.vars.get("first_layer_print_min").cloned(),
        c.vars.get("first_layer_print_max").cloned(),
    );
    let mut put = |k: &str, v: Value| {
        if !cfg.raw.contains_key(k) && !c.vars.contains_key(k) {
            c.vars.insert(k.to_owned(), v);
        }
    };
    let per_tool = |v: Value| Value::List(vec![v; tools]);
    put("chamber_temperature", per_tool(zero()));
    put("idle_temperature", per_tool(zero()));
    put("nozzle_temperature_range_high", per_tool(Value::Num(300.0)));
    put("nozzle_temperature_range_low", per_tool(Value::Num(190.0)));
    put("filament_multitool_ramming", per_tool(Value::Bool(false)));
    put("filament_max_volumetric_speed", per_tool(zero()));
    put("filament_notes", per_tool(Value::Str(String::new())));
    put("filament_type", per_tool(Value::Str("PLA".into())));
    put("filament_diameter", per_tool(Value::Num(cfg.filament_diameter)));
    put("printer_model", Value::Str(String::new()));
    put("printer_preset", Value::Str(String::new()));
    put("print_preset", Value::Str(String::new()));
    put("filament_preset", per_tool(Value::Str(String::new())));
    put("spiral_mode", Value::Bool(false));
    // `zhop` is the current tool's lift, one number (PrusaSlicer's placeholder); `z_hop` is the per-filament list.
    put("zhop", Value::Num(cfg.z_hop));
    put("z_hop", per_tool(Value::Num(cfg.z_hop)));
    put(
        "enable_pressure_advance",
        per_tool(Value::Bool(cfg.enable_pressure_advance)),
    );
    put(
        "pressure_advance",
        per_tool(Value::Num(cfg.pressure_advance.first().copied().unwrap_or(0.0))),
    );
    for (k, v) in [
        ("machine_max_acceleration_travel", 5000.0),
        ("machine_max_acceleration_extruding", 5000.0),
        ("machine_max_acceleration_x", 5000.0),
        ("machine_max_acceleration_y", 5000.0),
        ("machine_max_jerk_x", 8.0),
        ("machine_max_jerk_y", 8.0),
        ("outer_wall_acceleration", 5000.0),
        ("inner_wall_acceleration", 5000.0),
        ("top_surface_acceleration", 5000.0),
        ("sparse_infill_acceleration", 5000.0),
        ("bridge_acceleration", 5000.0),
        ("default_acceleration", 5000.0),
        ("initial_layer_acceleration", 500.0),
        ("travel_acceleration", 5000.0),
    ] {
        put(k, Value::List(vec![Value::Num(v)]));
    }
    // Tool change and wipe tower state, all at rest.
    for k in [
        "x_after_toolchange",
        "y_after_toolchange",
        "z_after_toolchange",
        "toolchange_count",
        "flush_length",
        "old_filament_e_feedrate",
        "new_filament_e_feedrate",
        "old_retract_length_toolchange",
        "new_retract_length_toolchange",
        "retract_length_toolchange",
        "travel_point_1_x",
        "travel_point_1_y",
        "travel_point_2_x",
        "travel_point_2_y",
        "travel_point_3_x",
        "travel_point_3_y",
    ] {
        put(k, zero());
    }
    for i in 1..=tools.max(4) {
        put(&format!("flush_length_{i}"), zero());
    }
    put("old_filament_temp", first_temp.clone());
    put("new_filament_temp", first_temp);
    // The bed's corners, and the footprint's, by axis.
    for (name, list) in [("first_layer_print_min", min), ("first_layer_print_max", max)] {
        if let Some(Value::List(l)) = list {
            for (i, v) in l.into_iter().enumerate() {
                put(&format!("{name}_{i}"), v);
            }
        }
    }
}

/// The profile's start G-code made safe for a resumed print: X and Y are homed
/// but Z is not, and nothing probes the bed, draws a purge line or moves the
/// nozzle down to the bed. `bottom_z` is the height the resumed layer starts at.
/// None when the start is only a firmware macro (its steps cannot be told apart),
/// so the caller falls back to the built-in resume sequence.
pub(crate) fn resume_start(
    cfg: &PrintConfig,
    ctx: &Context<'_>,
    bottom_z: f64,
) -> Result<Option<String>, String> {
    let Some(text) = render(cfg, ctx, "machine_start_gcode")? else {
        return Ok(None);
    };
    Ok(filter_resume_start(&text, bottom_z))
}

/// See [`resume_start`].
pub(crate) fn filter_resume_start(text: &str, bottom_z: f64) -> Option<String> {
    let mut out = String::with_capacity(text.len());
    let mut motion_commands = 0;
    for line in text.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next().map(str::to_ascii_uppercase) else {
            out.push_str(line);
            out.push('\n');
            continue;
        };
        let args: Vec<&str> = words.collect();
        let param = |c: char| {
            args.iter()
                .find(|w| w.to_ascii_uppercase().starts_with(c))
                .map(|w| &w[1..])
        };
        let num = |c: char| param(c).and_then(|v| v.parse::<f64>().ok());
        let is_gm = cmd.starts_with('G') || cmd.starts_with('M');
        if is_gm {
            motion_commands += 1;
        }
        let keep = match cmd.as_str() {
            // Homing: X and Y only. A bare G28 or one naming Z becomes X and Y; G28 Z alone goes.
            "G28" => {
                let only_z = !args.is_empty() && args.iter().all(|w| w.eq_ignore_ascii_case("Z"));
                if !only_z {
                    out.push_str("G28 X Y\n");
                }
                false
            }
            // Bed leveling, probing and gantry alignment move the nozzle to the bed or need Z.
            "G29" | "G34" | "G80" | "M420" | "BED_MESH_CALIBRATE" | "QUAD_GANTRY_LEVEL" | "Z_TILT_ADJUST"
            | "G32" | "PROBE" | "CALIBRATE_Z" => false,
            "G0" | "G1" | "G2" | "G3" => {
                let extrudes = num('E').is_some_and(|e| e > 0.0);
                // Purge and prime lines, and any move down toward the bed.
                let too_low = num('Z').is_some_and(|z| z < bottom_z - 0.01);
                !(extrudes || too_low)
            }
            _ => true,
        };
        if keep {
            out.push_str(line);
            out.push('\n');
        }
    }
    // Only a macro call (PRINT_START and the like): nothing here can be filtered.
    (motion_commands > 0).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::filter_resume_start;

    #[test]
    fn the_start_is_made_safe_for_a_resume() {
        let start = "; start\nM140 S60\nG28\nG29\nM190 S60\nM109 S215\nG1 Z0.3 F600\nG1 X10 Y10 Z0.3\n\
G1 X100 E12 F1000 ; purge\nG1 E5\nG1 E-1\nG1 Z10\nG92 E0\nBED_MESH_CALIBRATE\n";
        let f = filter_resume_start(start, 10.0).unwrap();
        let lines: Vec<&str> = f.lines().collect();
        assert_eq!(
            lines,
            [
                "; start",
                "M140 S60",
                "G28 X Y",
                "M190 S60",
                "M109 S215",
                "G1 E-1",
                "G1 Z10",
                "G92 E0"
            ]
        );
        assert_eq!(filter_resume_start("G28 Z\nG28 X Y Z", 5.0).unwrap(), "G28 X Y\n");
        // A start that is only a macro call cannot be filtered.
        assert!(filter_resume_start("PRINT_START BED=60 EXTRUDER=215\n", 5.0).is_none());
    }
}
