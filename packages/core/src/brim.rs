// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Automatic brim width (`brim_type` = `auto_brim`, Orca's default).
//!
//! Orca (`Brim.cpp`, `configBrimWidthByVolumeGroups`; `Model.cpp`, `findMaxSpeed`, `getThermalLength`;
//! `MaterialType.cpp`) sizes the brim of an object from how likely it is to tip or peel: a tall,
//! narrow part or a fast print gets a wide brim, a squat one none. The width grows with the height
//! over the footprint's second moment of area times the top print speed, and with the footprint's
//! diagonal relative to the material's thermal length, and is capped at 18 mm and at one and a half
//! diagonals. Widths under 5 mm are dropped. The material scales it by an adhesion coefficient.

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::SCALE;
use crate::geom::mm;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// The first filament's material name, empty when the profile names none.
fn material(cfg: &PrintConfig) -> String {
    match cfg.raw.get("filament_type") {
        Some(serde_json::Value::Array(a)) => a.first().and_then(|v| v.as_str()).map(str::to_owned),
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => None,
    }
    .unwrap_or_default()
}

/// Adhesion coefficient of a material (Orca's table; 1 for what it does not list).
fn adhesion(name: &str) -> f64 {
    match name {
        "FLEX" | "TPU" => 0.5,
        "PCTG" | "PET" | "PET-CF" | "PET-GF" | "PETG" => 2.0,
        _ => 1.0,
    }
}

/// Thermal length of a material in mm (200 for what Orca's table does not list).
fn thermal_length(name: &str) -> f64 {
    let nylon = name == "PA"
        || name.starts_with("PA-")
        || (name.starts_with("PA") && name[2..].starts_with(|c: char| c.is_ascii_digit()));
    match name {
        "FLEX" | "TPU" => 1000.0,
        "PC" | "PC-PBT" => 40.0,
        "PC-ABS" | "PC-CF" => 80.0,
        _ if name.starts_with("ABS") || name.starts_with("ASA") || nylon || name.starts_with("PET") => 100.0,
        _ => 200.0,
    }
}

/// The fastest of the print speeds Orca looks at, mm/s.
fn max_speed(cfg: &PrintConfig) -> f64 {
    [
        "inner_wall_speed",
        "outer_wall_speed",
        "sparse_infill_speed",
        "internal_solid_infill_speed",
        "top_surface_speed",
        "support_speed",
    ]
    .iter()
    .filter_map(|k| crate::motion::raw_f(cfg, k))
    .fold(0.0, f64::max)
}

type Pt = (f64, f64);

fn ring_mm(r: &[i_overlay::i_float::int::point::IntPoint<i32>]) -> Vec<Pt> {
    r.iter()
        .map(|p| (f64::from(p.x) / SCALE, f64::from(p.y) / SCALE))
        .collect()
}

/// Signed area, centroid and second moments about the origin of a ring (Orca's `compSecondMoment`):
/// `(area, centroid, (sum of y^2 terms, sum of x^2 terms))`, for the ring made counterclockwise.
fn moments(ring: &[Pt]) -> (f64, Pt, Pt) {
    let (mut a2, mut cx, mut cy, mut ix, mut iy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (&p1, &p2) in ring.iter().zip(ring.iter().cycle().skip(1)) {
        let cross = p1.0 * p2.1 - p2.0 * p1.1;
        a2 += cross;
        cx += (p1.0 + p2.0) * cross;
        cy += (p1.1 + p2.1) * cross;
        ix += (p1.1 * p1.1 + p1.1 * p2.1 + p2.1 * p2.1) * cross / 12.0;
        iy += (p1.0 * p1.0 + p1.0 * p2.0 + p2.0 * p2.0) * cross / 12.0;
    }
    let area = a2 / 2.0;
    if area.abs() < 1e-12 {
        return (0.0, (0.0, 0.0), (0.0, 0.0));
    }
    // A clockwise ring gives negated sums; Orca turns it around first, so moments are positive.
    let s = area.signum();
    (area, (cx / (6.0 * area), cy / (6.0 * area)), (ix * s, iy * s))
}

/// Second moments of the footprint about its own centroid, mm^4: `(Ixx, Iyy)`; `None` when empty.
fn second_moments(shapes: &Shapes) -> Option<Pt> {
    // One entry per island: (area, centroid, moments about the island's centroid).
    let mut props: Vec<(f64, Pt, Pt)> = Vec::new();
    for shape in shapes {
        let mut rings = shape.iter();
        let Some(outer) = rings.next() else { continue };
        let (mut area, c0, m0) = moments(&ring_mm(outer));
        if area <= 0.0 {
            // A clockwise outer ring: its area comes out negative; Orca's contour is counterclockwise.
            area = -area;
        }
        let (mut cx, mut cy) = (c0.0 * area, c0.1 * area);
        let (mut sx, mut sy) = m0;
        for hole in rings {
            let (ha, hc, hm) = moments(&ring_mm(hole));
            // Holes are clockwise in Orca, their area negative.
            let ha = -ha.abs();
            area += ha;
            cx += hc.0 * ha;
            cy += hc.1 * ha;
            sx -= hm.0.abs();
            sy -= hm.1.abs();
        }
        if area.abs() < 1e-12 {
            continue;
        }
        let (cx, cy) = (cx / area, cy / area);
        props.push((area, (cx, cy), (sx - cy * cy * area, sy - cx * cx * area)));
    }
    if props.is_empty() {
        return None;
    }
    let total: f64 = props.iter().map(|p| p.0).sum();
    let gx = props.iter().map(|p| p.1.0 * p.0).sum::<f64>() / total;
    let gy = props.iter().map(|p| p.1.1 * p.0).sum::<f64>() / total;
    let (mut ixx, mut iyy) = (0.0, 0.0);
    for (a, c, m) in &props {
        ixx += m.0 + a * (c.1 - gy) * (c.1 - gy);
        iyy += m.1 + a * (c.0 - gx) * (c.0 - gx);
    }
    Some((ixx, iyy))
}

/// Size of the bounding box of the outer rings, mm: `(width, depth)`.
fn extent(shapes: &Shapes) -> Pt {
    let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for ring in shapes.iter().filter_map(|s| s.first()) {
        for p in ring_mm(ring) {
            x0 = x0.min(p.0);
            x1 = x1.max(p.0);
            y0 = y0.min(p.1);
            y1 = y1.max(p.1);
        }
    }
    if x1 < x0 { (0.0, 0.0) } else { (x1 - x0, y1 - y0) }
}

/// The brim width in mm for the object whose first layer is `footprint` and whose height is
/// `height` (mm), before rounding to whole line spacings.
pub(crate) fn width(cfg: &PrintConfig, footprint: &Shapes, height: f64) -> f64 {
    let name = material(cfg);
    let (bx, by) = extent(footprint);
    let diagonal = bx.m_hypot(by);
    let Some((ixx, iyy)) = second_moments(footprint) else {
        return 0.0;
    };
    if ixx <= 0.0 || iyy <= 0.0 {
        return 0.0;
    }
    let height_to_area = (height / ixx * by).max(height / iyy * bx) * height / 1920.0;
    let raw = adhesion(&name)
        * (height_to_area * max_speed(cfg))
            .max(diagonal * 8.0 / thermal_length(&name) * height.min(30.0) / 30.0)
            .min(18.0)
            .min(1.5 * diagonal);
    // Small brims are omitted, large ones capped.
    if raw < 5.0 && raw < 1.5 * diagonal {
        0.0
    } else {
        raw.min(18.0)
    }
}

/// The object a first layer island belongs to: the one whose outline hull (`hulls`, convex, mm) holds most
/// of the island's outer ring, or lies nearest it when none does. 0 without objects.
pub(crate) fn owner(island: &[Vec<IntPoint<i32>>], hulls: &[&[[f64; 2]]]) -> usize {
    let ring = island.first().map(|r| ring_mm(r)).unwrap_or_default();
    let Some(&first) = ring.first() else { return 0 };
    let inside = |hull: &[[f64; 2]], p: Pt| hull_distance(hull, p) <= 0.05;
    let held: Vec<usize> = hulls
        .iter()
        .map(|h| ring.iter().filter(|p| inside(h, **p)).count())
        .collect();
    match held.iter().enumerate().max_by_key(|(_, n)| **n) {
        Some((k, n)) if *n > 0 => k,
        _ => hulls
            .iter()
            .enumerate()
            .min_by(|a, b| hull_distance(a.1, first).total_cmp(&hull_distance(b.1, first)))
            .map_or(0, |(k, _)| k),
    }
}

/// How far `p` lies outside a convex hull, mm; 0 inside it.
fn hull_distance(hull: &[[f64; 2]], p: Pt) -> f64 {
    if hull.len() < 3 {
        return hull
            .iter()
            .map(|q| (q[0] - p.0).m_hypot(q[1] - p.1))
            .fold(f64::MAX, f64::min);
    }
    let edges = || hull.iter().zip(hull.iter().cycle().skip(1));
    // Counterclockwise: inside is left of every edge.
    if edges().all(|(a, b)| (b[0] - a[0]) * (p.1 - a[1]) - (b[1] - a[1]) * (p.0 - a[0]) >= 0.0) {
        return 0.0;
    }
    edges()
        .map(|(a, b)| {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let len2 = dx * dx + dy * dy;
            let t = if len2 > 0.0 {
                (((p.0 - a[0]) * dx + (p.1 - a[1]) * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            (a[0] + t * dx - p.0).m_hypot(a[1] + t * dy - p.1)
        })
        .fold(f64::MAX, f64::min)
}

/// The brim width for one island of the first layer under `auto_brim`: the object's width, plus a
/// few millimeters for a tall part with a thin footprint that got none, and never more than the
/// island's own extent. `spacing` is the brim line spacing in mm.
pub(crate) fn island_width(object_width: f64, island: &Shapes, height: f64, spacing: f64) -> f64 {
    let mut w = object_width;
    if w < 5.0 && height > 10.0 {
        let outline = island.first().and_then(|s| s.first());
        let (area, length) = island.iter().fold((0.0, 0.0), |acc, s| {
            let Some(r) = s.first() else { return acc };
            let pts = ring_mm(r);
            let (a, _, _) = moments(&pts);
            let len: f64 = pts
                .iter()
                .zip(pts.iter().cycle().skip(1))
                .map(|(p, q)| (q.0 - p.0).m_hypot(q.1 - p.1))
                .sum();
            (acc.0 + a.abs(), acc.1 + len)
        });
        if outline.is_some() && length > 0.0 && area / length < 1.1 && w < spacing {
            w += (5.0 / spacing / 2.0).floor() * spacing * 2.0;
        }
    }
    let (ex, ey) = extent(island);
    w.min(ex.max(ey))
}

/// What the first layer's brim is made of (`brim_type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Off,
    Auto,
    Outer,
    Inner,
    Both,
    /// `brim_ears`: discs at the sharp corners, outside the part and inside its holes.
    Ears,
    /// `painted`: discs where the model carries brim ear points.
    Painted,
}

impl Kind {
    pub(crate) fn of(cfg: &PrintConfig) -> Self {
        match cfg.raw.get("brim_type") {
            Some(serde_json::Value::String(s)) => match s.as_str() {
                "no_brim" => Self::Off,
                "auto_brim" => Self::Auto,
                "inner_only" => Self::Inner,
                "outer_and_inner" => Self::Both,
                "brim_ears" => Self::Ears,
                "painted" => Self::Painted,
                _ => Self::Outer,
            },
            _ => Self::Outer,
        }
    }

    pub(crate) fn has_inner(self) -> bool {
        matches!(self, Self::Inner | Self::Both | Self::Ears | Self::Painted)
    }
}

/// A painted brim ear: where, and how far the disc reaches (internal units).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Ear {
    pub at: IntPoint<i32>,
    pub head_radius: f64,
}

type Ring = Vec<IntPoint<i32>>;

/// Orca's `POLY_SIDE_COUNT`: sides of an ear disc.
const EAR_SIDES: usize = 24;
const EAR_SIDES_F: f64 = 24.0;

fn disc(at: IntPoint<i32>, radius: i32) -> Ring {
    (0..EAR_SIDES)
        .map(|i| {
            let a = std::f64::consts::TAU * f64::from(u32::try_from(i).unwrap_or(0)) / EAR_SIDES_F;
            #[allow(clippy::cast_possible_truncation, reason = "a point near the part")]
            IntPoint::new(
                at.x + (f64::from(radius) * a.m_cos()) as i32,
                at.y + (f64::from(radius) * a.m_sin()) as i32,
            )
        })
        .collect()
}

fn area2(c: &[IntPoint<i32>]) -> i64 {
    crate::geom::area2_int(c)
}

/// Douglas-Peucker on an open polyline (Orca's `MultiPoint::_douglas_peucker`).
pub(crate) fn douglas_peucker(pts: &[IntPoint<i32>], tol: f64) -> Vec<IntPoint<i32>> {
    let n = pts.len();
    if n < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; n];
    if let Some(k) = keep.first_mut() {
        *k = true;
    }
    if let Some(k) = keep.last_mut() {
        *k = true;
    }
    let tol2 = tol * tol;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let (Some(pa), Some(pb)) = (pts.get(a), pts.get(b)) else {
            continue;
        };
        let (ax, ay) = (f64::from(pa.x), f64::from(pa.y));
        let (dx, dy) = (f64::from(pb.x) - ax, f64::from(pb.y) - ay);
        let l2 = dx * dx + dy * dy;
        let mut far = (0.0f64, a);
        for i in a + 1..b {
            let Some(p) = pts.get(i) else { continue };
            let (px, py) = (f64::from(p.x) - ax, f64::from(p.y) - ay);
            let t = if l2 > 0.0 {
                ((px * dx + py * dy) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let d2 = (px - t * dx).m_powi(2) + (py - t * dy).m_powi(2);
            if d2 > far.0 {
                far = (d2, i);
            }
        }
        if far.0 > tol2 {
            if let Some(k) = keep.get_mut(far.1) {
                *k = true;
            }
            stack.push((a, far.1));
            stack.push((far.1, b));
        }
    }
    pts.iter()
        .zip(&keep)
        .filter(|(_, k)| **k)
        .map(|(p, _)| *p)
        .collect()
}

/// The vertices of a counterclockwise ring that turn by more than `threshold` radians, left (convex) or
/// right (concave) (Orca's `convex_points` and `concave_points`).
fn corner_points(ring: &[IntPoint<i32>], threshold: f64, convex: bool) -> Vec<IntPoint<i32>> {
    let n = ring.len();
    let mut out = Vec::new();
    for i in 0..n {
        let (Some(&a), Some(&b), Some(&c)) = (ring.get((i + n - 1) % n), ring.get(i), ring.get((i + 1) % n))
        else {
            continue;
        };
        let (v1, v2) = (
            (f64::from(b.x - a.x), f64::from(b.y - a.y)),
            (f64::from(c.x - b.x), f64::from(c.y - b.y)),
        );
        let cross = v1.0 * v2.1 - v1.1 * v2.0;
        if (convex && cross <= 0.0) || (!convex && cross >= 0.0) {
            continue;
        }
        if threshold > 1e-9 {
            let (n1, n2) = (v1.0.m_hypot(v1.1), v2.0.m_hypot(v2.1));
            if n1 == 0.0 || n2 == 0.0 {
                continue;
            }
            let dot = (v1.0 * v2.0 + v1.1 * v2.1) / (n1 * n2);
            if dot >= threshold.next_up().m_cos() {
                continue;
            }
        }
        out.push(b);
    }
    out
}

/// Orca `make_brim_ears_auto`: discs of `size` at the corners of `shapes`' contours that turn by more than
/// `180 - max_angle` degrees, after the contours are simplified by `detection` (internal units). Outer
/// brims take convex corners, inner brims concave ones.
fn auto_ears(shapes: &Shapes, size: i32, detection: f64, max_angle_deg: f64, outer: bool) -> Shapes {
    if size <= 0 {
        return Vec::new();
    }
    let threshold = (180.0 - max_angle_deg).to_radians();
    let mut discs: Shapes = Vec::new();
    for shape in shapes {
        let Some(contour) = shape.first() else { continue };
        let mut ring = contour.clone();
        if area2(&ring) < 0 {
            ring.reverse();
        }
        // A Clipper ring starts at its lowest, leftmost vertex, and Douglas-Peucker keeps the points it
        // anchors on, so the start matters.
        if let Some(first) =
            (0..ring.len()).min_by_key(|&i| ring.get(i).map_or((i32::MAX, i32::MAX), |p| (p.y, p.x)))
        {
            ring.rotate_left(first);
        }
        if detection > 0.0 {
            let mut open = ring.clone();
            if let Some(&f) = open.first() {
                open.push(f);
            }
            let dp = douglas_peucker(&open, detection);
            // Not decimated below 4 points: that is surely enough to fill everything.
            if dp.len() > 4 {
                let mut d = dp;
                d.pop();
                ring = d;
            }
        }
        let pts = corner_points(&ring, threshold, outer);
        for p in pts {
            discs.push(vec![disc(p, size)]);
        }
    }
    discs
}

/// Loops of a brim area, as Orca's `tryExPolygonOffset`: the area pulled in half a spacing, then in
/// steps of a spacing (1.3 in, 0.3 out) until nothing is left; outermost first.
pub(crate) fn area_loops(area: &Shapes, spacing: i32) -> Vec<Ring> {
    let simplify = |s: Shapes| -> Shapes {
        s.into_iter()
            .map(|sh| {
                sh.into_iter()
                    .map(|c| perimeters::simplify_ring(&c, 125))
                    .collect()
            })
            .collect()
    };
    let sp = f64::from(spacing);
    #[allow(
        clippy::cast_possible_truncation,
        reason = "offsets of a fraction of a spacing"
    )]
    let by = |f: f64| (sp * f).round() as i32;
    let mut loops = Vec::new();
    // Orca offsets with round joins in both directions (`jtRound`); a mitered shrink keeps the sharp tips
    // of a toothed outline long, which pinches the brim between the teeth into islands of its own.
    let mut cur = perimeters::shrink_round(&simplify(area.clone()), by(0.5));
    let mut guard = 0;
    while !cur.is_empty() && guard < 200 {
        let cur_s = simplify(cur);
        for shape in &cur_s {
            for ring in shape {
                if ring.len() >= 3 {
                    loops.push(ring.clone());
                }
            }
        }
        let shrunk = perimeters::shrink_round(&cur_s, by(1.3));
        cur = perimeters::offset_round(&shrunk, by(0.3));
        guard += 1;
    }
    loops
}

/// Orca's brim area of one island of the first layer (`outer_inner_brim_area`): the band around its
/// outline for the outer kinds, the ears for `brim_ears` and `painted`, and the bands or ears inside its
/// holes for the inner kinds. `width` is the even-spacing brim width and `gap` the `brim_object_gap`, mm.
/// Painted ears are matched to the island they reach.
#[allow(clippy::too_many_arguments, reason = "one island's brim settings")]
pub(crate) fn island_areas(
    cfg: &PrintConfig,
    kind: Kind,
    island: &Shapes,
    all_islands: &Shapes,
    width: f64,
    spacing: f64,
    gap: f64,
    painted: &[Ear],
) -> Vec<Shapes> {
    let sp = mm(spacing);
    let gap_u = mm(gap);
    let size = mm(width - gap - spacing);
    let detection = cfg.raw_number("brim_ears_detection_length", 1.0) * SCALE;
    let max_angle = cfg.raw_number("brim_ears_max_angle", 125.0);
    let Some(shape) = island.first() else {
        return Vec::new();
    };
    let Some(outline) = shape.first() else {
        return Vec::new();
    };
    let mut areas: Vec<Shapes> = Vec::new();
    let contour_only: Shapes = vec![vec![outline.clone()]];
    let inner_ex = perimeters::offset_round(&contour_only, gap_u);
    let bodies = perimeters::offset_round(all_islands, gap_u);
    if matches!(kind, Kind::Auto | Kind::Outer | Kind::Both) {
        let outer = perimeters::offset_round(&inner_ex, mm(width));
        areas.push(perimeters::difference(&outer, &inner_ex));
    }
    let painted_ears = || -> Shapes {
        painted
            .iter()
            .map(|e| {
                // Orca: floor(radius / spacing / 2) * spacing * 2, less the gap and one spacing.
                let w = (e.head_radius / spacing / 2.0).floor() * spacing * 2.0;
                vec![disc(e.at, mm(w - gap - spacing).max(0))]
            })
            .collect()
    };
    match kind {
        Kind::Ears => {
            let ears = perimeters::union_all(&[&auto_ears(&inner_ex, size, detection, max_angle, true)]);
            areas.push(perimeters::difference(&ears, &bodies));
        }
        Kind::Painted => {
            let ears = perimeters::union_all(&[&painted_ears()]);
            let near: Shapes = perimeters::difference(&ears, &bodies)
                .into_iter()
                .filter(|s| {
                    let grown = perimeters::offset_round(&vec![s.clone()], 2 * sp);
                    !perimeters::intersection(&grown, island).is_empty()
                })
                .collect();
            areas.push(near);
        }
        _ => {}
    }
    // `brim_ears_outer_only` (newer Orca): ears (auto and painted) go on the outside only.
    let no_inner_ears =
        matches!(kind, Kind::Ears | Kind::Painted) && crate::tower::flag(cfg, "brim_ears_outer_only");
    if kind.has_inner() && !no_inner_ears && shape.len() > 1 {
        // The holes as filled shapes, counterclockwise.
        let holes: Shapes = shape
            .iter()
            .skip(1)
            .map(|h| {
                let mut r = h.clone();
                if area2(&r) < 0 {
                    r.reverse();
                }
                vec![r]
            })
            .collect();
        let width_u = mm(width);
        let outer_exp = perimeters::offset(&holes, -gap_u);
        let inner_exp = perimeters::offset(&holes, -(width_u + gap_u));
        let ears = match kind {
            Kind::Ears => auto_ears(&outer_exp, size, detection, max_angle, false),
            Kind::Painted => painted_ears(),
            _ => outer_exp,
        };
        let band = perimeters::difference(&ears, &inner_exp);
        areas.push(perimeters::intersection(&band, &holes));
    }
    areas
}

/// The brim loops of the areas of one filament: their union without the part (`no_brim_area`), keeping
/// the pieces that touch the part or each other (Orca: a brim area must contact an island or another
/// brim), as `tryExPolygonOffset` loops, outermost first.
pub(crate) fn finish(areas: &[Shapes], bodies: &Shapes, spacing: f64) -> Vec<Ring> {
    let sp = mm(spacing);
    let all: Vec<&Shapes> = areas.iter().collect();
    let free = perimeters::difference(&perimeters::union_all(&all), bodies);
    let grown: Vec<Shapes> = free
        .iter()
        .map(|s| perimeters::offset_round(&vec![s.clone()], 2 * sp))
        .collect();
    let kept: Shapes =
        free.iter()
            .enumerate()
            .filter(|(i, _)| {
                grown.get(*i).is_some_and(|g| {
                    !perimeters::intersection(g, bodies).is_empty()
                        || free.iter().enumerate().any(|(j, o)| {
                            j != *i && !perimeters::intersection(g, &vec![o.clone()]).is_empty()
                        })
                })
            })
            .map(|(_, s)| s.clone())
            .collect();
    outside_in(area_loops(&kept, sp))
}

/// The brim loops in Orca's print order (`union_pt_chained_outside_in`): the loops nest without crossing, and
/// each level is printed before the loops inside it, the siblings of a level chained nearest first from the
/// last loop printed (Orca chains them from no point; its source notes the last point as the better start).
fn outside_in(loops: Vec<Ring>) -> Vec<Ring> {
    let n = loops.len();
    if n < 2 {
        return loops;
    }
    let boxes: Vec<[i32; 4]> = loops
        .iter()
        .map(|r| {
            r.iter().fold([i32::MAX, i32::MAX, i32::MIN, i32::MIN], |b, p| {
                [b[0].min(p.x), b[1].min(p.y), b[2].max(p.x), b[3].max(p.y)]
            })
        })
        .collect();
    let area = |b: &[i32; 4]| i64::from(b[2] - b[0]) * i64::from(b[3] - b[1]);
    // The parent of a loop: the smallest loop around its first point.
    let parent: Vec<Option<usize>> = (0..n)
        .map(|i| {
            let p = *loops.get(i)?.first()?;
            let bi = boxes.get(i)?;
            (0..n)
                .filter(|&j| j != i)
                .filter(|&j| {
                    boxes.get(j).is_some_and(|b| {
                        b[0] <= bi[0] && b[1] <= bi[1] && b[2] >= bi[2] && b[3] >= bi[3] && area(b) > area(bi)
                    })
                })
                .filter(|&j| loops.get(j).is_some_and(|r| perimeters::point_in(r, p)))
                .min_by_key(|&j| boxes.get(j).map_or(i64::MAX, area))
        })
        .collect();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n + 1];
    for (i, p) in parent.iter().enumerate() {
        if let Some(c) = children.get_mut(p.unwrap_or(n)) {
            c.push(i);
        }
    }
    let first = |i: usize| -> crate::geom::Point {
        loops
            .get(i)
            .and_then(|r| r.first())
            .map_or(crate::geom::Point::new(0, 0), |p| {
                crate::geom::Point::new(p.x, p.y)
            })
    };
    let mut order: Vec<usize> = Vec::with_capacity(n);
    let root_start = first(0);
    visit(n, root_start, &children, &first, &mut order);
    let mut slots: Vec<Option<Ring>> = loops.into_iter().map(Some).collect();
    order
        .into_iter()
        .filter_map(|i| slots.get_mut(i).and_then(Option::take))
        .collect()
}

/// Puts the children of `node` in `order`, chained nearest first from `at`, each followed by its own children
/// (depth first, as Orca recurses). Returns where the last one starts.
fn visit(
    node: usize,
    at: crate::geom::Point,
    children: &[Vec<usize>],
    first: &dyn Fn(usize) -> crate::geom::Point,
    order: &mut Vec<usize>,
) -> crate::geom::Point {
    let Some(kids) = children.get(node) else { return at };
    let ents: Vec<crate::chain::Ent> = kids
        .iter()
        .map(|&k| crate::chain::Ent {
            first: first(k),
            last: first(k),
            reversible: false,
        })
        .collect();
    let mut cur = at;
    for (idx, _) in crate::chain::chain(&ents, at) {
        let Some(&k) = kids.get(idx) else { continue };
        order.push(k);
        cur = visit(k, first(k), children, first, order);
    }
    cur
}

#[cfg(test)]
mod tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    #[allow(clippy::cast_possible_truncation, reason = "a test footprint in range")]
    fn square(side_mm: f64) -> Shapes {
        let h = (side_mm * SCALE / 2.0) as i32;
        vec![vec![vec![
            IntPoint::new(-h, -h),
            IntPoint::new(h, -h),
            IntPoint::new(h, h),
            IntPoint::new(-h, h),
        ]]]
    }

    fn cfg() -> PrintConfig {
        let mut c = PrintConfig::default();
        for k in ["inner_wall_speed", "outer_wall_speed", "sparse_infill_speed"] {
            c.raw.insert(k.into(), serde_json::json!(200));
        }
        c.raw.insert("brim_type".into(), serde_json::json!("auto_brim"));
        c
    }

    #[test]
    fn a_squat_part_gets_no_brim_and_a_tall_thin_one_does() {
        let c = cfg();
        assert_eq!(Kind::of(&c), Kind::Auto);
        assert!(width(&c, &square(40.0), 6.0).abs() < 1e-9);
        let tall = width(&c, &square(10.0), 80.0);
        assert!((5.0..=18.0).contains(&tall), "{tall}");
    }

    #[test]
    fn material_scales_the_width_and_the_table_matches_orca() {
        assert!((adhesion("PETG") - 2.0).abs() < 1e-9 && (adhesion("PLA") - 1.0).abs() < 1e-9);
        assert!((thermal_length("PC") - 40.0).abs() < 1e-9);
        assert!((thermal_length("PA12-CF") - 100.0).abs() < 1e-9);
        assert!((thermal_length("PAHT-CF") - 200.0).abs() < 1e-9);
        assert!((thermal_length("TPU") - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn a_plus_shaped_hole_has_four_inner_ears_at_its_concave_corners() {
        #[allow(clippy::cast_possible_truncation, reason = "test coordinates")]
        let m = |v: f64| (v * SCALE) as i32;
        let plus: Vec<IntPoint<i32>> = [
            (12.0, 17.0),
            (17.0, 17.0),
            (17.0, 12.0),
            (23.0, 12.0),
            (23.0, 17.0),
            (28.0, 17.0),
            (28.0, 23.0),
            (23.0, 23.0),
            (23.0, 28.0),
            (17.0, 28.0),
            (17.0, 23.0),
            (12.0, 23.0),
        ]
        .iter()
        .map(|&(x, y)| IntPoint::new(m(x), m(y)))
        .collect();
        let ears = auto_ears(&vec![vec![plus]], m(4.5), 0.2 * SCALE, 125.0, false);
        assert_eq!(ears.len(), 4);
    }

    #[test]
    fn brim_ears_outer_only_leaves_the_holes_without_ears() {
        #[allow(clippy::cast_possible_truncation, reason = "test coordinates")]
        let m = |v: f64| (v * SCALE) as i32;
        let ring = |pts: &[(f64, f64)]| -> Vec<IntPoint<i32>> {
            pts.iter().map(|&(x, y)| IntPoint::new(m(x), m(y))).collect()
        };
        // A 40 mm block with a plus shaped hole (clockwise, as holes are).
        let mut hole = ring(&[
            (12.0, 17.0),
            (17.0, 17.0),
            (17.0, 12.0),
            (23.0, 12.0),
            (23.0, 17.0),
            (28.0, 17.0),
            (28.0, 23.0),
            (23.0, 23.0),
            (23.0, 28.0),
            (17.0, 28.0),
            (17.0, 23.0),
            (12.0, 23.0),
        ]);
        hole.reverse();
        let island: Shapes = vec![vec![
            ring(&[(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0)]),
            hole,
        ]];
        let run = |outer_only: bool| {
            let mut c = cfg();
            c.raw.insert("brim_type".into(), serde_json::json!("brim_ears"));
            c.raw
                .insert("brim_ears_outer_only".into(), serde_json::json!(outer_only));
            island_areas(&c, Kind::Ears, &island, &island, 5.0, 0.42, 0.0, &[])
        };
        let inside = |areas: &[Shapes]| {
            areas
                .iter()
                .flatten()
                .flatten()
                .flatten()
                .filter(|p| p.x > m(12.0) && p.x < m(28.0) && p.y > m(12.0) && p.y < m(28.0))
                .count()
        };
        assert!(inside(&run(false)) > 0);
        assert_eq!(inside(&run(true)), 0);
    }

    #[test]
    fn a_thin_footprint_under_a_tall_part_gets_extra_width() {
        // A 1 mm wide strip 20 mm tall: area over length is under 1.1 mm, so the extra 5 mm applies.
        let strip: Shapes = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(200_000, 0),
            IntPoint::new(200_000, 10_000),
            IntPoint::new(0, 10_000),
        ]]];
        assert!(island_width(0.0, &strip, 20.0, 0.4) > 4.0);
        assert!(island_width(0.0, &strip, 5.0, 0.4).abs() < 1e-9);
    }
}
