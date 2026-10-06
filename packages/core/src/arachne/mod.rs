// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Variable-width walls (the Arachne wall generator): walls whose line width follows the width of
//! the part, so thin features get a wider single line or a pair of lines instead of a gap, and the
//! wall count changes smoothly where the part's width changes. The method is the one in the paper
//! "A framework for adaptive width control of dense contour-parallel toolpaths in fused deposition
//! modeling" (Kuipers et al.): a skeleton of the outline, a bead count per skeleton region, and
//! walls traced between the skeleton and the outline.
//!
//! Lengths inside this module are nanometers; the public entry point takes the crate's 0.1 micrometer
//! units and returns them.

use crate::fm::Fm as _;
mod beading;
mod graph;
mod lines;
mod medial;
mod order;
mod plain;
mod skeleton;
mod voronoi;

pub(crate) use order::wall_order;

use crate::perimeters::{self, Shapes};
use graph::P;
use i_overlay::i_float::int::point::IntPoint;

pub(crate) use skeleton::Line;

/// Nanometers per internal unit (0.1 micrometer).
const NM_PER_UNIT: i64 = 100;

/// Settings of one wall generation, lengths in mm.
#[derive(Debug, Clone)]
pub(crate) struct Params {
    /// Spacing of the outer wall beads and of the inner ones.
    pub(crate) bead_width_0: f64,
    pub(crate) bead_width_x: f64,
    /// Number of walls asked for.
    pub(crate) inset_count: usize,
    /// How far the outer wall moves inward (negative outward).
    pub(crate) wall_0_inset: f64,
    pub(crate) layer_height: f64,
    pub(crate) nozzle_diameter: f64,
    /// Percentages of the nozzle diameter, as in the profile.
    pub(crate) min_feature_size: f64,
    pub(crate) min_bead_width: f64,
    pub(crate) wall_transition_length: f64,
    pub(crate) wall_transition_filter_deviation: f64,
    pub(crate) wall_transition_angle: f64,
    pub(crate) wall_distribution_count: i64,
    pub(crate) min_length_factor: f64,
    pub(crate) wall_maximum_resolution: f64,
    pub(crate) wall_maximum_deviation: f64,
    pub(crate) is_top_or_bottom_layer: bool,
    /// Athena: the center distance of the outer bead to the first inner one and of inner beads, mm.
    pub(crate) athena: Option<(f64, f64)>,
    /// Keeps the outline's Voronoi diagram for a later run on the same rings with other wall settings: the
    /// island walls of a layer with one-wall top surfaces are built with one wall and with all of them. The
    /// walls do not depend on it.
    pub(crate) keep_diagram: bool,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            bead_width_0: 0.4,
            bead_width_x: 0.4,
            inset_count: 2,
            wall_0_inset: 0.0,
            layer_height: 0.2,
            nozzle_diameter: 0.4,
            min_feature_size: 25.0,
            min_bead_width: 85.0,
            wall_transition_length: 100.0,
            wall_transition_filter_deviation: 25.0,
            wall_transition_angle: 10.0,
            wall_distribution_count: 1,
            min_length_factor: 0.5,
            wall_maximum_resolution: 0.5,
            wall_maximum_deviation: 0.025,
            is_top_or_bottom_layer: false,
            athena: None,
            keep_diagram: false,
        }
    }
}

/// One wall line in the crate's units: points with the width of the bead at each.
#[derive(Debug, Clone)]
pub(crate) struct WallLine {
    /// 0 is the outer wall.
    pub(crate) inset: usize,
    /// A gap filler along the middle of the skeleton, not a wall.
    pub(crate) is_odd: bool,
    /// Closed walls repeat their first point at the end.
    pub(crate) closed: bool,
    pub(crate) points: Vec<IntPoint<i32>>,
    pub(crate) widths: Vec<i32>,
}

/// The walls of a region and the area they leave inside.
#[derive(Debug, Clone, Default)]
pub(crate) struct Walls {
    pub(crate) lines: Vec<WallLine>,
    /// The area inside the innermost walls, for infill.
    pub(crate) inner: Shapes,
}

fn to_nm(v: f64) -> i64 {
    beading::nm(v)
}

/// Recent results of [`walls`] on this thread, newest last.
#[cfg(not(target_arch = "wasm32"))]
const RECENT_WALLS: usize = 16;

#[cfg(not(target_arch = "wasm32"))]
type RecentWalls = Vec<(u64, Vec<Vec<Vec<P>>>, Params, Option<Walls>)>;

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static RECENT: std::cell::RefCell<RecentWalls> = const { std::cell::RefCell::new(Vec::new()) };
}

/// A hash of the rings' points, to find a stored result before comparing the rings in full.
#[cfg(not(target_arch = "wasm32"))]
fn rings_hash(shapes: &[Vec<Vec<P>>]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |v: u64| h = (h ^ v).wrapping_mul(0x0000_0100_0000_01b3);
    for shape in shapes {
        mix(shape.len() as u64);
        for ring in shape {
            mix(ring.len() as u64);
            for p in ring {
                mix(p.x.cast_unsigned());
                mix(p.y.cast_unsigned());
            }
        }
    }
    h
}

/// Whether two settings give the same walls: every field equal, numbers bit for bit.
#[cfg(not(target_arch = "wasm32"))]
fn same_params(a: &Params, b: &Params) -> bool {
    let f = |x: f64, y: f64| x.to_bits() == y.to_bits();
    let pair = |x: Option<(f64, f64)>, y: Option<(f64, f64)>| match (x, y) {
        (None, None) => true,
        (Some(p), Some(q)) => f(p.0, q.0) && f(p.1, q.1),
        _ => false,
    };
    f(a.bead_width_0, b.bead_width_0)
        && f(a.bead_width_x, b.bead_width_x)
        && a.inset_count == b.inset_count
        && f(a.wall_0_inset, b.wall_0_inset)
        && f(a.layer_height, b.layer_height)
        && f(a.nozzle_diameter, b.nozzle_diameter)
        && f(a.min_feature_size, b.min_feature_size)
        && f(a.min_bead_width, b.min_bead_width)
        && f(a.wall_transition_length, b.wall_transition_length)
        && f(
            a.wall_transition_filter_deviation,
            b.wall_transition_filter_deviation,
        )
        && f(a.wall_transition_angle, b.wall_transition_angle)
        && a.wall_distribution_count == b.wall_distribution_count
        && f(a.min_length_factor, b.min_length_factor)
        && f(a.wall_maximum_resolution, b.wall_maximum_resolution)
        && f(a.wall_maximum_deviation, b.wall_maximum_deviation)
        && a.is_top_or_bottom_layer == b.is_top_or_bottom_layer
        && pair(a.athena, b.athena)
}

/// Generates the walls of `outline`. `None` when the outline could not be processed (the caller then
/// falls back to fixed-width walls).
pub(crate) fn walls(outline: &Shapes, prm: &Params) -> Option<Walls> {
    if prm.inset_count < 1 {
        return Some(Walls {
            lines: Vec::new(),
            inner: outline.clone(),
        });
    }
    let prepared = prepared_outline(outline, prm);
    if prepared.iter().all(Vec::is_empty) {
        return Some(Walls::default());
    }
    recent_or_new(prepared, prm)
}

/// The outline cleaned for the wall generator, one list of rings per shape.
fn prepared_outline(outline: &Shapes, prm: &Params) -> Vec<Vec<Vec<P>>> {
    let smallest_segment = to_nm(prm.wall_maximum_resolution);
    let allowed_distance = to_nm(prm.wall_maximum_deviation);
    let epsilon = allowed_distance / 2 - 1;
    let small_area_length = to_nm(prm.bead_width_0) as f64 / 2.0;
    prepare_outline(
        outline,
        epsilon,
        smallest_segment,
        allowed_distance,
        small_area_length,
    )
}

/// The walls of the prepared `rings` (the engine WASM has no room for the memo below in its size budget).
#[cfg(target_arch = "wasm32")]
#[allow(
    clippy::needless_pass_by_value,
    reason = "the same signature as the native memo"
)]
fn recent_or_new(rings: Vec<Vec<Vec<P>>>, prm: &Params) -> Option<Walls> {
    walls_of_rings(&rings, prm)
}

/// The walls of the prepared `rings`. Straight-sided parts give the same rings on many layers (the
/// points the slicing leaves along a straight side drop out in the preparation), so each thread keeps
/// its last few results and gives a stored one back when the rings and the settings are the same. The
/// walls depend on nothing else, so the result is the one a new run would give. A layer's walls are also
/// asked for by its neighbors (their shells and bridges read its infill area), usually on the same thread
/// a few islands earlier, so 16 results per thread are kept.
#[cfg(not(target_arch = "wasm32"))]
fn recent_or_new(rings: Vec<Vec<Vec<P>>>, prm: &Params) -> Option<Walls> {
    let h = rings_hash(&rings);
    let hit = RECENT.with(|r| {
        r.borrow()
            .iter()
            .rev()
            .find(|(k, o, p, _)| *k == h && *o == rings && same_params(p, prm))
            .map(|(_, _, _, w)| w.clone())
    });
    if let Some(w) = hit {
        return w;
    }
    let w = walls_of_rings(&rings, prm);
    RECENT.with(|r| {
        let mut r = r.borrow_mut();
        if r.len() >= RECENT_WALLS {
            let _ = r.remove(0);
        }
        r.push((h, rings, prm.clone(), w.clone()));
    });
    w
}

fn walls_of_rings(shapes: &[Vec<Vec<P>>], prm: &Params) -> Option<Walls> {
    let (strat, st) = strategy(prm);
    // aegis islands that are thick everywhere get their walls without the skeleton.
    let plain = if prm.athena.is_some() {
        plain::walls(
            shapes,
            &*strat,
            max_beads(prm),
            to_nm(prm.bead_width_x),
            plain_bump(prm),
        )
    } else {
        None
    };
    let (mut actual, contour) = match plain {
        Some(walls) => walls,
        None => skeleton_walls(shapes, prm, &*strat, &st)?,
    };
    simplify_insets(&mut actual, prm);
    let mut out = Walls::default();
    for inset in actual {
        for l in inset {
            if l.junctions.len() < 2 {
                continue;
            }
            out.lines.push(WallLine {
                inset: l.inset_idx,
                is_odd: l.is_odd,
                closed: l.is_closed,
                points: l.junctions.iter().map(|j| to_units(j.p)).collect(),
                widths: l.junctions.iter().map(|j| units(j.w)).collect(),
            });
        }
    }
    out.inner = inner_from_contour(&contour);
    // a broken diagram can send walls far off the part; the caller then falls back to fixed-width walls
    if strays(
        &out,
        shapes,
        to_nm(prm.bead_width_0.max(prm.bead_width_x) * 2.0 + prm.wall_0_inset.abs()),
    ) {
        return None;
    }
    Some(out)
}

/// Whether a wall point lies more than `margin` (nm) outside the bounds of the outline.
fn strays(w: &Walls, shapes: &[Vec<Vec<P>>], margin: i64) -> bool {
    let mut b = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
    for p in shapes.iter().flatten().flatten() {
        b = [b[0].min(p.x), b[1].min(p.y), b[2].max(p.x), b[3].max(p.y)];
    }
    w.lines.iter().flat_map(|l| &l.points).any(|p| {
        let (x, y) = (i64::from(p.x) * NM_PER_UNIT, i64::from(p.y) * NM_PER_UNIT);
        x < b[0] - margin || x > b[2] + margin || y < b[1] - margin || y > b[3] + margin
    })
}

/// Outline bumps shallower than this (half the smallest printable feature, nm) do not keep an island off
/// the fast path.
fn plain_bump(prm: &Params) -> i64 {
    to_nm(prm.min_feature_size * 0.01 * prm.nozzle_diameter) / 2
}

/// Beads across at most: two per wall asked for.
fn max_beads(prm: &Params) -> i64 {
    2 * i64::try_from(prm.inset_count).unwrap_or(i64::MAX / 4)
}

/// The wall lines simplified to the resolution and deviation of the settings; empty insets dropped.
fn simplify_insets(actual: &mut Vec<Vec<Line>>, prm: &Params) {
    let (smallest, allowed) = (
        to_nm(prm.wall_maximum_resolution),
        to_nm(prm.wall_maximum_deviation),
    );
    for inset in actual.iter_mut() {
        for line in inset {
            lines::simplify(line, smallest * smallest, allowed * allowed, to_nm(2.0));
        }
    }
    actual.retain(|i| !i.is_empty());
}

/// The bead strategy and skeleton settings of `prm`.
fn strategy(prm: &Params) -> (Box<dyn beading::Strategy>, skeleton::Settings) {
    let nozzle = prm.nozzle_diameter;
    let min_feature_size = to_nm(prm.min_feature_size * 0.01 * nozzle);
    let min_bead_width = to_nm(prm.min_bead_width * 0.01 * nozzle);
    let wall_transition_length = to_nm(prm.wall_transition_length * 0.01 * nozzle);
    let filter_deviation = to_nm(prm.wall_transition_filter_deviation * 0.01 * nozzle);
    let transitioning_angle = prm.wall_transition_angle.to_radians();

    let ext_width = prm.bead_width_0 + prm.layer_height * (1.0 - std::f64::consts::FRAC_PI_4);
    let per_width = prm.bead_width_x + prm.layer_height * (1.0 - std::f64::consts::FRAC_PI_4);
    let min_bead_mm = min_bead_width as f64 / beading::NM;
    let split_middle = (2.0 * min_bead_mm / ext_width - 1.0).clamp(0.01, 0.99);
    let add_middle = (min_bead_mm / per_width).clamp(0.01, 0.99);
    let strat = beading::make(&beading::Params {
        outer_width: to_nm(prm.bead_width_0),
        inner_width: to_nm(prm.bead_width_x),
        transition_length: wall_transition_length,
        transitioning_angle,
        print_thin_walls: true,
        min_bead_width,
        min_feature_size,
        split_middle,
        add_middle,
        max_bead_count: max_beads(prm),
        outer_inset: to_nm(prm.wall_0_inset),
        distribution_count: prm.wall_distribution_count,
        min_variable_ratio: 0.5,
        athena: prm.athena.map(|(e, i)| (to_nm(e), to_nm(i))),
    });
    let st = skeleton::Settings {
        keep_diagram: prm.keep_diagram,
        transitioning_angle: strat.transitioning_angle(),
        discretization_step: to_nm(0.8),
        transition_filter_dist: to_nm(100.0),
        allowed_filter_deviation: filter_deviation,
        propagation_transition_dist: wall_transition_length,
    };
    (strat, st)
}

/// Wall lines per inset, and the rings where the infill area starts.
type InsetsAndContour = (Vec<Vec<Line>>, Vec<Vec<P>>);

/// The walls (per inset) and the inner contour of `shapes` through the skeleton.
fn skeleton_walls(
    shapes: &[Vec<Vec<P>>],
    prm: &Params,
    strat: &dyn beading::Strategy,
    st: &skeleton::Settings,
) -> Option<InsetsAndContour> {
    let rings: Vec<Vec<P>> = shapes.iter().flatten().cloned().collect();
    if rings.is_empty() {
        return None;
    }
    let insets = skeleton::generate(&rings, strat, st)?;
    // Stitch the pieces of each inset into closed walls.
    let stitch_distance = to_nm(prm.bead_width_x) - 1;
    // The zero-width lines where the infill area starts stop wherever fewer beads than the full count fill
    // the island (a gear tooth under one wall), and start again past it. Arachne (as in Orca) joins them
    // across a bead width. Athena's spacing puts the thickness where the full count begins past a bead
    // width, so under aegis they join across up to that thickness; otherwise the contour stays open, is
    // dropped, and the infill area loses the outline it lies in.
    let contour_distance = if prm.athena.is_some() {
        stitch_distance.max(strat.transition_thickness(max_beads(prm) - 1))
    } else {
        stitch_distance
    };
    let mut stitched: Vec<Vec<Line>> = Vec::with_capacity(insets.len());
    for inset in &insets {
        let zero_width = !inset.is_empty() && inset.iter().all(|l| l.junctions.iter().all(|j| j.w == 0));
        let distance = if zero_width {
            contour_distance
        } else {
            stitch_distance
        };
        let (mut open, closed) = lines::stitch(inset, distance, to_nm(0.01));
        for mut line in closed {
            if line.junctions.is_empty() {
                continue;
            }
            if let (Some(first), Some(last)) =
                (line.junctions.first().copied(), line.junctions.last().copied())
                && first.p != last.p
                && graph::dist(first.p, last.p) < distance
            {
                line.junctions.push(first);
            }
            line.is_closed = true;
            open.push(line);
        }
        stitched.push(open);
    }
    for inset in &mut stitched {
        lines::remove_small_lines(inset, prm.is_top_or_bottom_layer, prm.min_length_factor);
    }
    Some(lines::separate_inner_contour(stitched))
}

/// A setting that may carry a percent sign (`25%`), as a number.
/// A setting in mm that may be given as a percent of `reference` (Orca's `get_abs_value`).
fn abs_value(cfg: &crate::config::PrintConfig, key: &str, reference: f64, default_percent: f64) -> f64 {
    let v = match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a.first(),
        other => other,
    };
    match v {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(serde_json::Value::String(t)) => match t.trim().strip_suffix('%') {
            Some(p) => p.trim().parse::<f64>().unwrap_or(default_percent) * reference / 100.0,
            None => t.trim().parse().unwrap_or(0.0),
        },
        _ => default_percent * reference / 100.0,
    }
}

fn percent(cfg: &crate::config::PrintConfig, key: &str, default: f64) -> f64 {
    let v = match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a.first(),
        other => other,
    };
    match v {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(default),
        Some(serde_json::Value::String(t)) => {
            t.trim().trim_end_matches('%').trim().parse().unwrap_or(default)
        }
        _ => default,
    }
}

/// Walls of every island of `region` by the Arachne generator, in the shape the rest of the pipeline
/// reads: per island the wall lines, and the area left for infill (`overlap` is the infill overlap,
/// in units). Falls back to fixed-width walls for an island the generator cannot process.
pub(crate) fn island_walls(
    region: &Shapes,
    cfg: &crate::config::PrintConfig,
    loops: u32,
    overlap: i32,
    layer_height: f64,
    top_or_bottom: bool,
    top: Option<&perimeters::TopCtx>,
) -> (Vec<perimeters::IslandWalls>, Shapes) {
    let (spacing_0, spacing_x) = (
        cfg.spacing_for(cfg.outer_wall_width()),
        cfg.spacing_for(cfg.inner_wall_width()),
    );
    let w = crate::geom::mm(cfg.line_width);
    // Precise outer wall (Orca default, only with inner walls printed first): the outline goes in by
    // the whole difference between width and spacing, and the outer bead moves back out by half of it,
    // so the outer wall stays on the surface and the walls inside get that room.
    let precise = crate::tower::flag_or(cfg, "precise_outer_wall", true)
        && cfg.wall_sequence == crate::config::WallSequence::InnerOuter;
    let half_gap = (cfg.outer_wall_width() - spacing_0) / 2.0;
    let prm = Params {
        bead_width_0: spacing_0,
        bead_width_x: spacing_x,
        inset_count: loops as usize,
        wall_0_inset: if precise { -half_gap } else { 0.0 },
        layer_height,
        nozzle_diameter: cfg.nozzle_diameter,
        min_feature_size: percent(cfg, "min_feature_size", 25.0),
        min_bead_width: percent(
            cfg,
            if top_or_bottom {
                "initial_layer_min_bead_width"
            } else {
                "min_bead_width"
            },
            85.0,
        ),
        wall_transition_length: percent(cfg, "wall_transition_length", 100.0),
        wall_transition_filter_deviation: percent(cfg, "wall_transition_filter_deviation", 25.0),
        wall_transition_angle: percent(cfg, "wall_transition_angle", 10.0),
        #[allow(clippy::cast_possible_truncation, reason = "a small count")]
        wall_distribution_count: percent(cfg, "wall_distribution_count", 1.0) as i64,
        min_length_factor: percent(cfg, "min_length_factor", 0.5),
        wall_maximum_resolution: percent(cfg, "wall_maximum_resolution", 0.5),
        wall_maximum_deviation: percent(cfg, "wall_maximum_deviation", 0.025),
        is_top_or_bottom_layer: top_or_bottom,
        athena: crate::config::athena_spacing(
            cfg,
            cfg.outer_wall_width(),
            cfg.inner_wall_width(),
            layer_height,
        ),
        // Where one-wall top surfaces apply (`one_wall_top`), these rings are built again with one wall.
        keep_diagram: loops > 1 && crate::tower::flag(cfg, "only_one_wall_top"),
    };
    // The outline is taken in to where the outer bead's edge would be if its width were the spacing.
    let inset = crate::geom::mm(if precise { 2.0 * half_gap } else { half_gap });
    let min_infill_spacing = crate::geom::mm(cfg.flow_spacing() * 0.6);
    let resolution = f64::from(crate::geom::mm(cfg.raw_number("resolution", 0.012).max(1e-4)));
    let mut islands = Vec::with_capacity(region.len());
    let mut inner: Shapes = Vec::new();
    for shape in region {
        let one: Shapes = vec![shape.clone()];
        let outline = if inset > 0 {
            perimeters::offset(&one, -inset)
        } else {
            one.clone()
        };
        let generated = if loops == 0 {
            None
        } else if let Some(t) = top.filter(|_| loops > 1) {
            one_wall_top(&outline, &prm, cfg, t)
        } else {
            walls(&outline, &prm)
        };
        if let Some(g) = generated {
            // The infill boundary: the walls' inner edge simplified to the resolution (Orca's `simplify_p` in
            // `PerimeterGenerator::add_infill_contour_for_arachne`), opened by half a line and grown by the overlap.
            let simple = simplify_rings(&g.inner, resolution);
            let opened = perimeters::offset(&simple, -(min_infill_spacing / 2));
            let grown = perimeters::offset(&opened, overlap + min_infill_spacing / 2);
            inner.extend(grown);
            islands.push(perimeters::IslandWalls {
                wide: g.lines,
                ..perimeters::IslandWalls::default()
            });
        } else {
            let (isl, core) = perimeters::walls(&one, loops, w, overlap);
            inner.extend(core);
            islands.extend(isl);
        }
    }
    (islands, inner)
}

/// Each ring of `shapes` closed, simplified by Douglas-Peucker within `tolerance` (units) and opened again,
/// then merged (`ExPolygon::simplify_p` followed by `union_ex`). The walls' inner contour carries a point
/// at every junction of the skeleton, several times what the resolution needs.
fn simplify_rings(shapes: &Shapes, tolerance: f64) -> Shapes {
    let rings: Shapes = shapes
        .iter()
        .map(|shape| {
            shape
                .iter()
                .filter_map(|ring| {
                    let mut closed = ring.clone();
                    closed.push(*ring.first()?);
                    let mut s = crate::brim::douglas_peucker(&closed, tolerance);
                    s.pop();
                    (s.len() >= 3).then_some(s)
                })
                .collect::<Vec<_>>()
        })
        .filter(|s: &Vec<_>| !s.is_empty())
        .collect();
    if rings.is_empty() {
        rings
    } else {
        perimeters::union_all(&[&rings])
    }
}

/// The medial axis of one thin shape as variable-width lines (gap fill): where the shape is between
/// `min_mm` and `max_mm` thick, one line down the middle with the thickness at each point as its width.
pub(crate) fn medial_lines(shape: &Shapes, min_mm: f64, max_mm: f64) -> Vec<WallLine> {
    let prepared = prepare_outline(shape, to_nm(0.002), to_nm(0.02), to_nm(0.01), 0.0);
    let rings: Vec<Vec<P>> = prepared.into_iter().flatten().collect();
    if rings.is_empty() {
        return Vec::new();
    }
    medial::lines(&rings, to_nm(min_mm), to_nm(max_mm))
        .into_iter()
        .map(|(pts, widths)| WallLine {
            inset: 0,
            is_odd: true,
            closed: false,
            points: pts.into_iter().map(to_units).collect(),
            widths: widths.into_iter().map(units).collect(),
        })
        .collect()
}

/// Walls with one wall where the layer has a top surface (`only_one_wall_top`, Orca:
/// `PerimeterGenerator::process_arachne`, "One wall top surface for Arachne"): the outer wall goes round the
/// whole island, the part of the infill area no layer above covers keeps just that wall, and the rest
/// gets the remaining walls, as a separate set inside it. With no top surface the walls are the usual.
fn one_wall_top(
    outline: &Shapes,
    prm: &Params,
    cfg: &crate::config::PrintConfig,
    t: &perimeters::TopCtx,
) -> Option<Walls> {
    // The infill area inside the outer wall lies inside the outline as the generator prepares it, which
    // the simplification moves out by at most the allowed deviation. Where the layer above covers all of
    // that there is no top surface, and the walls are the usual ones without the one-wall run.
    let reach = crate::geom::mm(prm.wall_maximum_deviation) + 2;
    if perimeters::difference(&perimeters::offset(outline, reach), t.upper).is_empty() {
        return walls(outline, prm);
    }
    let first = Params {
        inset_count: 1,
        ..prm.clone()
    };
    let one = walls(outline, &first)?;
    let contour = one.inner.clone();
    let mut top = perimeters::difference(&contour, t.upper);
    if top.is_empty() {
        return walls(outline, prm);
    }
    let spacing_0 = crate::geom::mm(prm.bead_width_0);
    let width = crate::geom::mm(cfg.inner_wall_width());
    if let Some(lower) = t.lower {
        // Bridges over air stay out of the one-wall area.
        let reach = spacing_0.max(width);
        let bridges = perimeters::offset(&perimeters::difference(&top, lower), reach);
        top = perimeters::difference(&top, &bridges);
    }
    // Drop slivers, then grow the rest to hide the wall line.
    let min_width = (spacing_0 / 4 + 1).max(
        crate::geom::mm(abs_value(
            cfg,
            "min_width_top_surface",
            cfg.inner_wall_width(),
            300.0,
        )) / 4,
    );
    let grow = min_width + width * 85 / 100;
    top = perimeters::offset(&perimeters::offset(&top, -min_width), grow);
    let not_top = perimeters::difference(&contour, &top);
    top = perimeters::intersection(&top, &contour);
    let inner_prm = Params {
        bead_width_0: prm.bead_width_x,
        inset_count: prm.inset_count.saturating_sub(1),
        wall_0_inset: 0.0,
        keep_diagram: false,
        ..prm.clone()
    };
    let grown = perimeters::offset(&not_top, crate::geom::mm(-prm.wall_0_inset));
    let inner_walls = walls(&grown, &inner_prm)?;
    let mut lines = one.lines;
    let has_outer = !lines.is_empty();
    for mut l in inner_walls.lines {
        if has_outer {
            l.inset += 1;
        }
        lines.push(l);
    }
    Some(Walls {
        lines,
        inner: perimeters::union_all(&[&top, &inner_walls.inner]),
    })
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "coordinates fit the i32 grid of the crate"
)]
fn to_units(p: P) -> IntPoint<i32> {
    IntPoint::new(
        (p.x as f64 / NM_PER_UNIT as f64).round() as i32,
        (p.y as f64 / NM_PER_UNIT as f64).round() as i32,
    )
}

#[allow(clippy::cast_possible_truncation, reason = "a width in units")]
fn units(nm: i64) -> i32 {
    (nm as f64 / NM_PER_UNIT as f64).round() as i32
}

/// The infill area from the closed zero-width lines: even-odd union of their rings.
fn inner_from_contour(contour: &[Vec<P>]) -> Shapes {
    use i_overlay::core::fill_rule::FillRule;
    use i_overlay::core::overlay::IntOverlayOptions;
    use i_overlay::core::simplify::Simplify;
    if contour.is_empty() {
        return Vec::new();
    }
    let rings: Vec<Vec<IntPoint<i32>>> = contour
        .iter()
        .filter(|r| r.len() >= 3)
        .map(|r| r.iter().map(|p| to_units(*p)).collect())
        .collect();
    if rings.is_empty() {
        return Vec::new();
    }
    rings.simplify(FillRule::EvenOdd, IntOverlayOptions::default())
}

// Outline preparation: the Voronoi diagram needs clean input, with no self intersections and no
// needless detail.

fn ring_to_nm(r: &[IntPoint<i32>]) -> Vec<P> {
    r.iter()
        .map(|p| P::new(i64::from(p.x) * NM_PER_UNIT, i64::from(p.y) * NM_PER_UNIT))
        .collect()
}

fn area2(r: &[P]) -> i128 {
    let n = r.len();
    (0..n)
        .map(|i| {
            let (a, b) = (r[i], r[(i + 1) % n]);
            i128::from(a.x) * i128::from(b.y) - i128::from(b.x) * i128::from(a.y)
        })
        .sum()
}

/// Cleans the outline: rounds corners slightly, merges points, removes tiny pieces. Returns one
/// list of rings per shape (outer counter-clockwise first, holes clockwise).
fn prepare_outline(
    outline: &Shapes,
    epsilon: i64,
    smallest: i64,
    allowed: i64,
    small_area_length: f64,
) -> Vec<Vec<Vec<P>>> {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a distance of a few micrometers in units"
    )]
    let eps_units = (epsilon / NM_PER_UNIT).max(1) as i32;
    let step1 = perimeters::offset(outline, -eps_units);
    let step2 = perimeters::offset(&step1, eps_units * 2);
    let step3 = perimeters::offset(&step2, -eps_units);
    // one list of rings, outer counter-clockwise, holes clockwise, as orca's WallToolPaths::generate works on them
    let mut rings: Vec<Vec<P>> = Vec::new();
    for shape in &step3 {
        for (k, ring) in shape.iter().enumerate() {
            let mut r = ring_to_nm(ring);
            if (area2(&r) > 0) != (k == 0) {
                r.reverse();
            }
            rings.push(r);
        }
    }
    clean_rings(rings, epsilon, smallest, allowed, small_area_length)
}

/// The rings simplified for the voronoi diagram, with no crossings left: simplifying can fold a thin
/// sliver so that one side crosses the other.
fn clean_rings(
    mut rings: Vec<Vec<P>>,
    epsilon: i64,
    smallest: i64,
    allowed: i64,
    small_area_length: f64,
) -> Vec<Vec<Vec<P>>> {
    for r in &mut rings {
        simplify_ring(r, smallest * smallest, allowed * allowed);
    }
    rings.retain(|r| r.len() >= 3);
    fix_self_intersections(epsilon, &mut rings);
    for r in &mut rings {
        remove_degenerate_vertices(r);
        remove_colinear(r, 0.005);
    }
    // removing collinear points can make new crossings
    fix_self_intersections(epsilon, &mut rings);
    for r in &mut rings {
        remove_degenerate_vertices(r);
    }
    remove_small_areas(&mut rings, small_area_length * small_area_length);
    // the steps above can still leave rings that cross each other, which the voronoi builder cannot take
    union_rings(&rings)
}

/// Rings smaller than `min_area` (nm squared): outer rings with the holes that start inside them, and
/// small holes.
fn remove_small_areas(rings: &mut Vec<Vec<P>>, min_area: f64) {
    #[allow(clippy::cast_precision_loss, reason = "areas in nm squared")]
    let small = |r: &[P]| (area2(r).abs() as f64) / 2.0 < min_area;
    let gone: Vec<Vec<P>> = rings
        .iter()
        .filter(|r| r.len() < 3 || (small(r) && area2(r) > 0))
        .cloned()
        .collect();
    rings.retain(|r| r.len() >= 3 && !small(r));
    if !gone.is_empty() {
        rings.retain(|r| area2(r) > 0 || !gone.iter().any(|o| contains(o, r[0])));
    }
}

/// Even-odd containment of `p` in ring `r`.
fn contains(r: &[P], p: P) -> bool {
    let n = r.len();
    let mut inside = false;
    for i in 0..n {
        let (a, b) = (r[i], r[(i + 1) % n]);
        if (a.y > p.y) != (b.y > p.y) {
            let lhs = i128::from(p.x - a.x) * i128::from(b.y - a.y);
            let rhs = i128::from(b.x - a.x) * i128::from(p.y - a.y);
            if (lhs < rhs) == (b.y > a.y) {
                inside = !inside;
            }
        }
    }
    inside
}

/// Grid cell size for [`fix_self_intersections`], nm.
const FIX_CELL: i64 = 2_000_000;

/// Orca's `fixSelfIntersections`: points closer than half of `epsilon` to another segment move a little off
/// it, then the rings are resolved even-odd.
fn fix_self_intersections(epsilon: i64, rings: &mut Vec<Vec<P>>) {
    if epsilon >= 1 {
        let half = (epsilon + 1) / 2;
        let move_dist = (half - 2).max(2);
        let cell = |v: i64| v.div_euclid(FIX_CELL);
        let mut grid: std::collections::HashMap<(i64, i64), Vec<(usize, usize)>> =
            std::collections::HashMap::new();
        for (ri, r) in rings.iter().enumerate() {
            let n = r.len();
            for i in 0..n {
                let (a, b) = (r[i], r[(i + 1) % n]);
                for cx in cell(a.x.min(b.x))..=cell(a.x.max(b.x)) {
                    for cy in cell(a.y.min(b.y))..=cell(a.y.max(b.y)) {
                        grid.entry((cx, cy)).or_default().push((ri, i));
                    }
                }
            }
        }
        let mut near: Vec<(usize, usize)> = Vec::new();
        for ri in 0..rings.len() {
            let n = rings[ri].len();
            for i in 0..n {
                let pt = rings[ri][i];
                near.clear();
                for cx in cell(pt.x - epsilon)..=cell(pt.x + epsilon) {
                    for cy in cell(pt.y - epsilon)..=cell(pt.y + epsilon) {
                        if let Some(v) = grid.get(&(cx, cy)) {
                            near.extend_from_slice(v);
                        }
                    }
                }
                near.sort_unstable();
                near.dedup();
                let mut pt = pt;
                for &(rj, j) in &near {
                    let m = rings[rj].len();
                    if ri == rj && (i == j || i == (j + 1) % m) {
                        continue;
                    }
                    let (a, b) = (rings[rj][j], rings[rj][(j + 1) % m]);
                    let c = closest_on_segment(pt, a, b);
                    let d = pt.minus(c);
                    if i128::from(d.x) * i128::from(d.x) + i128::from(d.y) * i128::from(d.y)
                        > i128::from(half) * i128::from(half)
                    {
                        continue;
                    }
                    let other = rings[ri][(i + 1) % n];
                    let ab = b.minus(a);
                    let left = i128::from(ab.x) * i128::from(other.y - a.y)
                        - i128::from(ab.y) * i128::from(other.x - a.x)
                        > 0;
                    let v = if left { ab } else { a.minus(b) };
                    let len = v.len();
                    if len > 0 {
                        pt.x += -v.y * move_dist / len;
                        pt.y += v.x * move_dist / len;
                    }
                }
                rings[ri][i] = pt;
            }
        }
    }
    *rings = overlay_rings(rings, i_overlay::core::fill_rule::FillRule::EvenOdd)
        .into_iter()
        .flatten()
        .collect();
}

/// The point of segment `ab` nearest `p`.
fn closest_on_segment(p: P, a: P, b: P) -> P {
    let ab = b.minus(a);
    let l2 = i128::from(ab.x) * i128::from(ab.x) + i128::from(ab.y) * i128::from(ab.y);
    if l2 == 0 {
        return a;
    }
    let t = i128::from(p.x - a.x) * i128::from(ab.x) + i128::from(p.y - a.y) * i128::from(ab.y);
    if t <= 0 {
        return a;
    }
    if t >= l2 {
        return b;
    }
    #[allow(clippy::cast_possible_truncation, reason = "a point on the segment")]
    P::new(
        a.x + (i128::from(ab.x) * t / l2) as i64,
        a.y + (i128::from(ab.y) * t / l2) as i64,
    )
}

/// Orca's final `union_` of the prepared outline (non-zero), as shapes: outer ring counter-clockwise first,
/// holes clockwise.
fn union_rings(rings: &[Vec<P>]) -> Vec<Vec<Vec<P>>> {
    overlay_rings(rings, i_overlay::core::fill_rule::FillRule::NonZero)
        .into_iter()
        .map(|shape| {
            shape
                .into_iter()
                .enumerate()
                .map(|(k, mut r)| {
                    if (area2(&r) > 0) != (k == 0) {
                        r.reverse();
                    }
                    r
                })
                .collect::<Vec<_>>()
        })
        .filter(|s: &Vec<Vec<P>>| !s.is_empty())
        .collect()
}

/// The rings resolved with `rule`, as shapes in nm.
fn overlay_rings(rings: &[Vec<P>], rule: i_overlay::core::fill_rule::FillRule) -> Vec<Vec<Vec<P>>> {
    use i_overlay::core::overlay::IntOverlayOptions;
    use i_overlay::core::simplify::Simplify;
    let input: Vec<Vec<IntPoint<i64>>> = rings
        .iter()
        .filter(|r| r.len() >= 3)
        .map(|r| r.iter().map(|p| IntPoint::new(p.x, p.y)).collect())
        .collect();
    if input.is_empty() {
        return Vec::new();
    }
    input
        .simplify(rule, IntOverlayOptions::default())
        .into_iter()
        .map(|shape| {
            shape
                .into_iter()
                .map(|r| r.into_iter().map(|p| P::new(p.x, p.y)).collect())
                .collect()
        })
        .collect()
}

/// Removes points of a ring that cut off little: points on short segments when the shortcut stays
/// within the allowed distance, and points that lie on a straight line.
fn simplify_ring(ring: &mut Vec<P>, smallest_sq: i64, allowed_sq: i64) {
    if ring.len() < 3 {
        ring.clear();
        return;
    }
    if ring.len() == 3 {
        return;
    }
    let n = ring.len();
    let cross = |a: P, b: P| i128::from(a.x) * i128::from(b.y) - i128::from(a.y) * i128::from(b.x);
    let mut out: Vec<P> = Vec::with_capacity(n);
    let mut previous = ring[n - 1];
    let mut previous_previous = ring[n - 2];
    let mut current = ring[0];
    let mut accumulated = cross(previous, current);
    let tiny = to_nm(0.005);
    for idx in 0..n {
        current = ring[idx];
        let next = if idx + 1 < n {
            ring[idx + 1]
        } else if out.len() > 1 {
            out[0]
        } else {
            ring[(idx + 1) % n]
        };
        let removed_next = cross(current, next);
        let negative_closing = cross(next, previous);
        accumulated += removed_next;
        let d = current.minus(previous);
        let length2 = i128::from(d.dot(d));
        if length2 < i128::from(tiny) * i128::from(tiny) {
            continue;
        }
        let area_so_far = accumulated + negative_closing;
        let base = next.minus(previous);
        let base2 = i128::from(base.dot(base));
        if base2 == 0 {
            continue;
        }
        #[allow(clippy::cast_precision_loss, reason = "areas in nm squared")]
        let height2 = (area_so_far as f64 * area_so_far as f64 / base2 as f64) as i128;
        if height2 <= i128::from(tiny) * i128::from(tiny)
            && point_line_distance(current, previous, next) <= tiny as f64
        {
            continue;
        }
        if length2 < i128::from(smallest_sq) && height2 <= i128::from(allowed_sq) {
            let dn = current.minus(next);
            let next_len2 = i128::from(dn.dot(dn));
            if next_len2 > 4 * i128::from(smallest_sq) {
                // The next edge is long: move the point to where the two long edges meet, if that is near.
                let inter = line_meet(previous_previous, previous, current, next);
                let near = |a: P, b: P| {
                    let d = a.minus(b);
                    i128::from(d.dot(d)) <= i128::from(smallest_sq)
                };
                #[allow(clippy::cast_precision_loss, reason = "distances in nm")]
                let ok = inter.is_some_and(|ip| {
                    let e = point_line_distance(ip, previous, current);
                    e * e <= allowed_sq as f64 && near(ip, previous) && near(ip, next)
                });
                if let (true, Some(ip)) = (ok, inter) {
                    current = ip;
                    if !out.is_empty() {
                        out.pop();
                        previous = previous_previous;
                    }
                } else {
                    // Nothing better to do; keep the point.
                    accumulated = removed_next;
                    previous_previous = previous;
                    previous = current;
                    out.push(current);
                    continue;
                }
            } else {
                continue;
            }
        }
        accumulated = removed_next;
        previous_previous = previous;
        previous = current;
        out.push(current);
    }
    *ring = out;
}

fn point_line_distance(p: P, a: P, b: P) -> f64 {
    let ab = b.minus(a);
    let l = ab.len_f();
    if l == 0.0 {
        return p.minus(a).len_f();
    }
    #[allow(clippy::cast_precision_loss, reason = "coordinates in nm")]
    let c = (ab.x as f64 * (p.y - a.y) as f64 - ab.y as f64 * (p.x - a.x) as f64).abs();
    c / l
}

fn line_meet(a: P, b: P, c: P, d: P) -> Option<P> {
    let (r, s) = (b.minus(a), d.minus(c));
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        reason = "coordinates in nm"
    )]
    {
        let denom = r.x as f64 * s.y as f64 - r.y as f64 * s.x as f64;
        if denom == 0.0 {
            return None;
        }
        let ca = c.minus(a);
        let t = (ca.x as f64 * s.y as f64 - ca.y as f64 * s.x as f64) / denom;
        Some(P::new(
            a.x + (r.x as f64 * t).round() as i64,
            a.y + (r.y as f64 * t).round() as i64,
        ))
    }
}

/// Removes points where the ring turns back on itself.
fn remove_degenerate_vertices(ring: &mut Vec<P>) {
    let degenerate = |last: P, now: P, next: P| {
        let (a, b) = (now.minus(last), next.minus(now));
        let dot = i128::from(a.x) * i128::from(b.x) + i128::from(a.y) * i128::from(b.y);
        #[allow(clippy::cast_precision_loss, reason = "coordinates in nm")]
        let prod = a.len_f() * b.len_f();
        #[allow(clippy::cast_precision_loss, reason = "coordinates in nm")]
        {
            (dot as f64 + prod).abs() < 0.5 && prod > 0.0
        }
    };
    let n = ring.len();
    if n < 3 {
        return;
    }
    let mut result: Vec<P> = Vec::with_capacity(n);
    let mut changed = false;
    for idx in 0..n {
        let last = result.last().copied().unwrap_or(ring[n - 1]);
        if idx + 1 == n && result.is_empty() {
            break;
        }
        let next = if idx + 1 == n { result[0] } else { ring[idx + 1] };
        if degenerate(last, ring[idx], next) {
            changed = true;
            while result.len() > 1 && degenerate(result[result.len() - 2], result[result.len() - 1], next) {
                result.pop();
            }
        } else {
            result.push(ring[idx]);
        }
    }
    if changed {
        if result.len() > 2 {
            *ring = result;
        } else {
            ring.clear();
        }
    }
}

/// Removes points where the ring turns by less than `max_deviation` radians (almost straight).
fn remove_colinear(ring: &mut Vec<P>, max_deviation: f64) {
    loop {
        let n = ring.len();
        if n <= 3 {
            return;
        }
        let mut removed = false;
        let mut out: Vec<P> = Vec::with_capacity(n);
        let mut skip_next = false;
        for i in 0..n {
            if skip_next {
                skip_next = false;
                out.push(ring[i]);
                continue;
            }
            let (prev, pt, next) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
            let (a, b) = (pt.minus(prev), next.minus(pt));
            #[allow(clippy::cast_precision_loss, reason = "coordinates in nm")]
            let (cr, dt) = (
                (a.x as f64 * b.y as f64 - a.y as f64 * b.x as f64),
                (a.x as f64 * b.x as f64 + a.y as f64 * b.y as f64),
            );
            let turn = cr.m_atan2(dt).abs();
            if turn > max_deviation && turn < std::f64::consts::PI - max_deviation {
                out.push(pt);
            } else {
                removed = true;
                skip_next = true;
            }
        }
        if !removed || out.len() == n {
            return;
        }
        *ring = out;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(w_mm: f64, h_mm: f64) -> Shapes {
        let (w, h) = ((w_mm * 10_000.0) as i32, (h_mm * 10_000.0) as i32);
        vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(w, 0),
            IntPoint::new(w, h),
            IntPoint::new(0, h),
        ]]]
    }

    fn count_walls(r: &Walls) -> usize {
        r.lines.iter().map(|l| l.inset).max().map_or(0, |m| m + 1)
    }

    /// Proper crossings between the segments of `rings`, neighbors in a ring left out.
    fn crossings(rings: &[Vec<P>]) -> usize {
        let segs: Vec<(usize, usize, P, P)> = rings
            .iter()
            .enumerate()
            .flat_map(|(ri, r)| (0..r.len()).map(move |i| (ri, i, r[i], r[(i + 1) % r.len()])))
            .collect();
        let side = |a: P, b: P, c: P| {
            (i128::from(b.x - a.x) * i128::from(c.y - a.y) - i128::from(b.y - a.y) * i128::from(c.x - a.x))
                .signum()
        };
        let mut n = 0;
        for (k, s) in segs.iter().enumerate() {
            for t in &segs[k + 1..] {
                let m = rings[s.0].len();
                if s.0 == t.0 && ((s.1 + 1) % m == t.1 || (t.1 + 1) % m == s.1) {
                    continue;
                }
                if side(s.2, s.3, t.2) * side(s.2, s.3, t.3) < 0
                    && side(t.2, t.3, s.2) * side(t.2, t.3, s.3) < 0
                {
                    n += 1;
                }
            }
        }
        n
    }

    /// a thin sliver left by the slice: a stepped lower side, an upper side a few hundredths of a mm
    /// above, whose step corners sit just past the line from end to end
    fn sliver() -> Vec<P> {
        let mm = |x: f64, y: f64| P::new((x * 1e6).round() as i64, (y * 1e6).round() as i64);
        vec![
            mm(0.362, 0.293),
            mm(0.0, 0.0),
            mm(0.010, -0.028),
            mm(0.080, -0.030),
            mm(0.380, 0.272),
            mm(0.480, 0.268),
            mm(0.680, 0.472),
            mm(0.780, 0.468),
            mm(0.955, 0.646),
            mm(0.940, 0.668),
            mm(0.655, 0.494),
        ]
    }

    #[test]
    fn a_folded_sliver_is_resolved_before_the_voronoi_diagram() {
        let (smallest, allowed) = (to_nm(0.5), to_nm(0.025));
        assert_eq!(crossings(&[sliver()]), 0);
        // simplifying alone drops the upper side and folds the ring across its own steps
        let mut folded = sliver();
        simplify_ring(&mut folded, smallest * smallest, allowed * allowed);
        assert!(crossings(&[folded]) > 0);
        let shapes = clean_rings(vec![sliver()], allowed / 2 - 1, smallest, allowed, 100.0);
        let rings: Vec<Vec<P>> = shapes.into_iter().flatten().collect();
        assert!(!rings.is_empty());
        assert_eq!(crossings(&rings), 0, "{rings:?}");
    }

    #[test]
    fn walls_far_off_the_outline_are_refused() {
        let ring = vec![
            P::new(0, 0),
            P::new(10_000_000, 0),
            P::new(10_000_000, 10_000_000),
            P::new(0, 10_000_000),
        ];
        let line = |x: i32| WallLine {
            inset: 0,
            is_odd: false,
            closed: false,
            points: vec![IntPoint::new(10_000, 10_000), IntPoint::new(x, 10_000)],
            widths: vec![4000, 4000],
        };
        let walls = |x| Walls {
            lines: vec![line(x)],
            inner: Vec::new(),
        };
        assert!(!strays(&walls(90_000), &[vec![ring.clone()]], to_nm(0.8)));
        assert!(strays(&walls(-30_000_000), &[vec![ring]], to_nm(0.8)));
    }

    #[test]
    fn a_thick_rectangle_gets_the_asked_walls_at_full_width() {
        let prm = Params {
            bead_width_0: 0.4,
            bead_width_x: 0.4,
            inset_count: 2,
            ..Params::default()
        };
        let r = walls(&rect(20.0, 10.0), &prm).expect("walls");
        assert_eq!(
            count_walls(&r),
            2,
            "{:?}",
            r.lines
                .iter()
                .map(|l| (l.inset, l.is_odd, l.closed, l.points.len()))
                .collect::<Vec<_>>()
        );
        // Widths near the optimum (0.4 mm = 4000 units) on the straight parts.
        let widths: Vec<i32> = r.lines.iter().flat_map(|l| l.widths.iter().copied()).collect();
        assert!(widths.iter().all(|w| (3000..5000).contains(w)), "{widths:?}");
        assert!(!r.inner.is_empty());
    }

    /// The first layer of the benchmark gear (18 teeth of module 1.5 round a 5 mm bore), as the walls get
    /// it: the root at 11.43 mm, the tips at 14.81 mm, units of 0.1 um.
    fn gear_outline() -> Shapes {
        // One tooth period of 20 degrees: (angle in degrees, radius in mm).
        let tooth = [
            (0.0, 11.432),
            (1.96, 11.434),
            (3.37, 12.428),
            (4.48, 14.502),
            (5.37, 14.806),
            (9.35, 14.806),
            (10.4, 12.857),
            (11.72, 11.435),
        ];
        let at = |deg: f64, r: f64| {
            let a = deg.to_radians();
            IntPoint::new(
                (r * a.m_cos() * 10_000.0).round() as i32,
                (r * a.m_sin() * 10_000.0).round() as i32,
            )
        };
        let outer: Vec<IntPoint<i32>> = (0..18)
            .flat_map(|k| tooth.iter().map(move |&(d, r)| (f64::from(k) * 20.0 + d, r)))
            .map(|(d, r)| at(d, r))
            .collect();
        let hole: Vec<IntPoint<i32>> = (0..32)
            .rev()
            .map(|k| at(f64::from(k) * 360.0 / 32.0, 2.693))
            .collect();
        vec![vec![outer, hole]]
    }

    /// aegis spaces its beads by the line spacing, so a gear tooth holds one bead over a part wider than a
    /// bead. The zero-width lines where the infill area starts stop at each such tooth; joined only across a
    /// bead width they stayed open and were dropped, and the infill area became a disk over the bore, outside
    /// the part, with the rest of the layer left empty.
    #[test]
    fn aegis_infill_area_of_a_one_wall_gear_stays_inside_it() {
        let gear = gear_outline();
        let prm = Params {
            bead_width_0: 0.457,
            bead_width_x: 0.457,
            inset_count: 1,
            wall_0_inset: -0.0215,
            is_top_or_bottom_layer: true,
            athena: Some((0.457, 0.457)),
            ..Params::default()
        };
        let r = walls(&gear, &prm).expect("walls");
        let reach = crate::geom::mm(prm.wall_maximum_deviation) + 2;
        let outside = perimeters::difference(&r.inner, &perimeters::offset(&gear, reach));
        assert!(outside.is_empty(), "infill area outside the gear: {outside:?}");
        let rings: Vec<usize> = r.inner.iter().map(Vec::len).collect();
        assert_eq!(rings, vec![2], "one infill area round the bore");
        let area = |s: &Shapes| -> f64 {
            s.iter()
                .flatten()
                .map(|ring| {
                    let n = ring.len();
                    (0..n)
                        .map(|i| {
                            let (p, q) = (ring[i], ring[(i + 1) % n]);
                            f64::from(p.x) * f64::from(q.y) - f64::from(q.x) * f64::from(p.y)
                        })
                        .sum::<f64>()
                        / 2.0
                })
                .sum()
        };
        // The gear is about 480 mm2; one wall round its teeth and the bore leaves about 390.
        assert!(area(&r.inner) > 350.0e8, "{}", area(&r.inner) / 1e8);
    }

    fn dump(name: &str, r: &Walls) {
        eprintln!(
            "== {name}: {} lines, inner area shapes {}",
            r.lines.len(),
            r.inner.len()
        );
        for l in &r.lines {
            let (lo, hi) = (
                l.widths.iter().min().copied().unwrap_or(0),
                l.widths.iter().max().copied().unwrap_or(0),
            );
            eprintln!(
                "  inset {} odd {} closed {} pts {} width {}..{} first {:?} last {:?}",
                l.inset,
                l.is_odd,
                l.closed,
                l.points.len(),
                lo,
                hi,
                l.points.first().map(|p| (p.x, p.y)),
                l.points.last().map(|p| (p.x, p.y))
            );
        }
    }

    /// A 1.2 mm bar with two walls at the default 0.42 mm widths: Orca's precise outer wall keeps the
    /// outer beads on the surface and leaves the middle bead the rest of the bar, 0.36 mm of spacing.
    #[test]
    fn precise_outer_wall_gives_the_middle_bead_the_room_left() {
        let cfg = crate::config::PrintConfig::builtin();
        let bar = rect(20.0, 1.2);
        let (islands, _) = island_walls(&bar, &cfg, 2, 0, 0.2, false, None);
        let wide: Vec<&WallLine> = islands.iter().flat_map(|i| i.wide.iter()).collect();
        let middle = wide.iter().find(|l| l.is_odd).expect("a middle bead");
        let mid = middle.widths[middle.widths.len() / 2];
        let expect = crate::geom::mm(1.2 - 2.0 * cfg.outer_wall_width());
        assert!((mid - expect).abs() < 40, "{mid} vs {expect}");
    }

    /// Thin, spiky, degenerate and self-crossing outlines through both generators (aegis and Arachne, one to
    /// four walls): nothing panics, every line is well formed and stays near its outline, and an outline
    /// with room for a bead always gets walls.
    #[test]
    fn walls_survive_broken_and_thin_outlines() {
        let mut seed: u64 = 0x5358_4145_4749_5331;
        let mut next = move || {
            seed = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = seed;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            f64::from(u32::try_from((z ^ (z >> 31)) >> 32).unwrap_or(0)) / f64::from(u32::MAX)
        };
        for case in 0..240 {
            // A star whose rays range from slivers to thick lobes, with repeated and collinear points.
            let n = 3 + (next() * 40.0) as usize;
            let base = 0.2 + next() * 6.0;
            let mut ring: Vec<IntPoint<i32>> = Vec::new();
            for i in 0..n {
                let a = std::f64::consts::TAU * (i as f64 + 0.3 * next()) / n as f64;
                let r = if case % 3 == 0 {
                    base * (0.05 + next())
                } else {
                    base * (0.6 + 0.4 * next())
                };
                let p = IntPoint::new(
                    (r * 10_000.0 * a.m_cos()) as i32,
                    (r * 10_000.0 * a.m_sin()) as i32,
                );
                ring.push(p);
                if next() < 0.1 {
                    ring.push(p);
                }
            }
            if case % 5 == 0 {
                // Self-crossing: swap two points.
                let (i, j) = (
                    (next() * n as f64) as usize % ring.len(),
                    (next() * n as f64) as usize % ring.len(),
                );
                ring.swap(i, j);
            }
            let raw: Shapes = vec![vec![ring]];
            let clean = crate::perimeters::union_all(&[&raw]);
            let area = crate::shells::area_mm2(&clean);
            let bb = crate::perimeters::bounds(&clean);
            for (outline, cleaned) in [(&raw, false), (&clean, true)] {
                for athena in [None, Some((0.4, 0.4))] {
                    let prm = Params {
                        bead_width_0: 0.42,
                        bead_width_x: 0.45,
                        inset_count: 1 + case % 4,
                        athena,
                        ..Params::default()
                    };
                    let Some(w) = walls(outline, &prm) else { continue };
                    for l in &w.lines {
                        assert_eq!(l.points.len(), l.widths.len(), "case {case}");
                        assert!(
                            l.widths.iter().all(|&x| x > 0 && x < 30_000),
                            "case {case}: {:?}",
                            l.widths
                        );
                        if l.closed {
                            assert_eq!(l.points.first(), l.points.last(), "case {case}");
                        }
                        if let (true, Some(b)) = (cleaned, bb) {
                            let m = 5_000;
                            assert!(
                                l.points.iter().all(|p| p.x >= b[0] - m
                                    && p.x <= b[2] + m
                                    && p.y >= b[1] - m
                                    && p.y <= b[3] + m),
                                "case {case}: a wall leaves its outline"
                            );
                        }
                    }
                    if cleaned && area > 2.0 {
                        assert!(!w.lines.is_empty(), "case {case}: {area} mm2 got no walls");
                    }
                }
            }
        }
    }

    #[test]
    fn dump_shapes() {
        let prm = Params {
            bead_width_0: 0.4,
            bead_width_x: 0.4,
            inset_count: 3,
            ..Params::default()
        };
        dump("rect 20x10", &walls(&rect(20.0, 10.0), &prm).expect("w"));
        dump("strip 10x0.5", &walls(&rect(10.0, 0.5), &prm).expect("w"));
        dump("strip 10x1.0", &walls(&rect(10.0, 1.0), &prm).expect("w"));
        dump("strip 10x1.3", &walls(&rect(10.0, 1.3), &prm).expect("w"));
        // A wedge from 0.3 to 3 mm wide.
        let wedge: Shapes = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(200_000, 0),
            IntPoint::new(200_000, 30_000),
            IntPoint::new(0, 3_000),
        ]]];
        dump("wedge", &walls(&wedge, &prm).expect("w"));
        // A ring 1.5 mm thick.
        let n = 64;
        let circ = |r: f64, rev: bool| -> Vec<IntPoint<i32>> {
            let mut v: Vec<IntPoint<i32>> = (0..n)
                .map(|i| {
                    let a = std::f64::consts::TAU * f64::from(i) / f64::from(n);
                    IntPoint::new(
                        (r * 10_000.0 * a.m_cos()) as i32,
                        (r * 10_000.0 * a.m_sin()) as i32,
                    )
                })
                .collect();
            if rev {
                v.reverse();
            }
            v
        };
        let ring: Shapes = vec![vec![circ(10.0, false), circ(8.5, true)]];
        dump("ring 1.5", &walls(&ring, &prm).expect("w"));
    }

    /// A small deterministic generator for the stress test.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 33) as f64) / f64::from(1u32 << 31)
        }
    }

    /// Random shapes made of thick strokes: many thin parts, junctions, corners and holes.
    fn doodle(rng: &mut Lcg) -> Shapes {
        use i_overlay::core::fill_rule::FillRule;
        use i_overlay::core::overlay::IntOverlayOptions;
        use i_overlay::core::simplify::Simplify;
        let mut rects: Vec<Vec<IntPoint<i32>>> = Vec::new();
        let strokes = 2 + (rng.next() * 6.0) as usize;
        for _ in 0..strokes {
            let (x, y) = (rng.next() * 30.0, rng.next() * 30.0);
            let (a, len) = (rng.next() * std::f64::consts::TAU, 3.0 + rng.next() * 25.0);
            let half = 0.15 + rng.next() * 1.6;
            let (dx, dy) = (a.m_cos(), a.m_sin());
            let (nx, ny) = (-dy * half, dx * half);
            let p = |px: f64, py: f64| IntPoint::new((px * 10_000.0) as i32, (py * 10_000.0) as i32);
            rects.push(vec![
                p(x + nx, y + ny),
                p(x + dx * len + nx, y + dy * len + ny),
                p(x + dx * len - nx, y + dy * len - ny),
                p(x - nx, y - ny),
            ]);
        }
        rects.simplify(FillRule::NonZero, IntOverlayOptions::default())
    }

    #[test]
    fn random_thin_shapes_never_panic_or_loop_and_keep_their_widths_sane() {
        let prm = Params {
            inset_count: 3,
            ..Params::default()
        };
        let mut rng = Lcg(0x5EED);
        let (mut some, mut none) = (0, 0);
        for case in 0..300 {
            let shapes = doodle(&mut rng);
            for shape in &shapes {
                let one: Shapes = vec![shape.clone()];
                match walls(&one, &prm) {
                    Some(w) => {
                        some += 1;
                        for l in &w.lines {
                            assert_eq!(l.points.len(), l.widths.len(), "case {case}");
                            // A bead is never wider than the nozzle's 4 times, nor negative.
                            assert!(
                                l.widths.iter().all(|x| (0..=40_000).contains(x)),
                                "case {case} {:?}",
                                l.widths
                            );
                            if l.closed {
                                assert_eq!(l.points.first(), l.points.last(), "case {case}");
                            }
                        }
                    }
                    None => none += 1,
                }
            }
        }
        assert!(some > 200, "{some} generated, {none} fell back");
        assert!(none * 10 < some + none, "{none} of {} fell back", some + none);
    }

    #[test]
    fn a_thin_strip_gets_one_wide_line() {
        let prm = Params {
            bead_width_0: 0.4,
            bead_width_x: 0.4,
            inset_count: 2,
            ..Params::default()
        };
        let r = walls(&rect(10.0, 0.5), &prm).expect("walls");
        assert!(!r.lines.is_empty());
        let total: usize = r.lines.len();
        assert!(total <= 3, "{total}");
        let wmax = r
            .lines
            .iter()
            .flat_map(|l| l.widths.iter())
            .max()
            .copied()
            .unwrap_or(0);
        assert!(wmax >= 3000, "{wmax}");
    }
}
