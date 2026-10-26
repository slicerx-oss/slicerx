// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Walls that hang over the layer below. As in Orca's `PerimeterGenerator`
//! (`traverse_loops`, `traverse_extrusions`), a wall whose center line lies
//! more than half the nozzle outside the lower layer hangs completely free: a
//! wall ring is cut where it crosses the lower layer grown by half the nozzle,
//! and the stretches outside are written as overhang walls, at the bridge speed
//! and with Orca's overhang flow (the bridge flow of an inner wall). The
//! slowdown by how far a wall hangs is set point by point in `quality.rs`.
//!
//! Rings are short and support regions have few edges next to the mesh, so
//! the cuts are computed directly on a coarse edge grid instead of through
//! polygon clipping, which costs far more per ring than the walls themselves.

// Grid indices and cell counts are small (a bed of 2 mm cells), so these casts are exact.
#![allow(
    clippy::cast_possible_wrap,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use crate::config::PrintConfig;
use crate::fm::Fm;
use crate::output::RaisedWall;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;
use std::sync::Arc;

type Pt = IntPoint<i32>;

/// Boundary edges of a region on a uniform grid, for point tests and
/// segment crossings.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Support {
    edges: Vec<[Pt; 2]>,
    min_x: i64,
    min_y: i64,
    nx: usize,
    ny: usize,
    /// CSR: edges overlapping cell `c` are `items[start[c]..start[c + 1]]`.
    start: Vec<u32>,
    items: Vec<u32>,
}

/// Grid cell size, 2 mm.
const CELL: i64 = 20_000;

impl Support {
    pub(crate) fn new(shapes: &Shapes) -> Self {
        let mut edges: Vec<[Pt; 2]> = Vec::new();
        for ring in shapes.iter().flat_map(|s| s.iter()) {
            let n = ring.len();
            for i in 0..n {
                if let (Some(&a), Some(&b)) = (ring.get(i), ring.get((i + 1) % n))
                    && a != b
                {
                    edges.push([a, b]);
                }
            }
        }
        Self::from_edges(edges)
    }

    /// A grid over loose segments, kept in the given order (edge `i` is segment `i`), zero-length ones
    /// included.
    pub(crate) fn from_edges(edges: Vec<[Pt; 2]>) -> Self {
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for p in edges.iter().flatten() {
            (x0, y0, x1, y1) = (x0.min(p.x), y0.min(p.y), x1.max(p.x), y1.max(p.y));
        }
        if edges.is_empty() {
            return Self::default();
        }
        let b = [x0, y0, x1, y1];
        let (min_x, min_y) = (i64::from(b[0]), i64::from(b[1]));
        let nx = usize::try_from((i64::from(b[2]) - min_x) / CELL + 1).unwrap_or(1);
        let ny = usize::try_from((i64::from(b[3]) - min_y) / CELL + 1).unwrap_or(1);
        let mut me = Self {
            edges,
            min_x,
            min_y,
            nx,
            ny,
            start: Vec::new(),
            items: Vec::new(),
        };
        let mut counts = vec![0u32; nx * ny + 1];
        for e in &me.edges {
            for (cx, cy) in me.cells(e[0], e[1]) {
                if let Some(c) = counts.get_mut(cy * nx + cx) {
                    *c += 1;
                }
            }
        }
        let mut acc = 0u32;
        me.start = counts
            .iter()
            .map(|c| {
                let s = acc;
                acc += c;
                s
            })
            .collect();
        let mut fill = me.start.clone();
        me.items = vec![0; acc as usize];
        for (i, e) in me.edges.iter().enumerate() {
            for (cx, cy) in me.cells(e[0], e[1]) {
                if let Some(f) = fill.get_mut(cy * nx + cx) {
                    if let Some(slot) = me.items.get_mut(*f as usize) {
                        *slot = u32::try_from(i).unwrap_or(0);
                    }
                    *f += 1;
                }
            }
        }
        me
    }

    #[allow(clippy::cast_sign_loss, reason = "coordinates are clamped to the grid first")]
    fn cell_of(&self, x: i64, y: i64) -> (usize, usize) {
        let cx = ((x - self.min_x) / CELL).clamp(0, self.nx as i64 - 1) as usize;
        let cy = ((y - self.min_y) / CELL).clamp(0, self.ny as i64 - 1) as usize;
        (cx, cy)
    }

    /// Cells the bounding box of a segment touches.
    fn cells(&self, a: Pt, b: Pt) -> impl Iterator<Item = (usize, usize)> + use<> {
        let (x0, y0) = self.cell_of(i64::from(a.x.min(b.x)), i64::from(a.y.min(b.y)));
        let (x1, y1) = self.cell_of(i64::from(a.x.max(b.x)), i64::from(a.y.max(b.y)));
        (y0..=y1).flat_map(move |cy| (x0..=x1).map(move |cx| (cx, cy)))
    }

    fn cell_edges(&self, cx: usize, cy: usize) -> &[u32] {
        let c = cy * self.nx + cx;
        match (self.start.get(c), self.start.get(c + 1)) {
            (Some(&a), Some(&b)) => self.items.get(a as usize..b as usize).unwrap_or(&[]),
            _ => &[],
        }
    }

    /// Distance in mm from `p` to the nearest boundary edge, negative when `p` is inside (Orca's signed
    /// `distance_from_lines`). Infinite for a region without edges.
    pub(crate) fn signed_distance(&self, p: Pt) -> f64 {
        let Some((d, _)) = self.nearest(p) else {
            return f64::INFINITY;
        };
        if self.inside(p) { -d } else { d }
    }

    /// The nearest edge to `p`: its distance in mm and its index. None without edges.
    #[allow(clippy::cast_precision_loss, reason = "a few cells of 2 mm")]
    pub(crate) fn nearest(&self, p: Pt) -> Option<(f64, usize)> {
        if self.edges.is_empty() {
            return None;
        }
        let mut best = (f64::INFINITY, 0usize);
        let take = |best: &mut (f64, usize), ei: usize, e: &[Pt; 2]| {
            let d = seg_dist2(p, e);
            // The first of equal edges, as a scan in edge order finds it.
            if d < best.0 || (d.to_bits() == best.0.to_bits() && ei < best.1) {
                *best = (d, ei);
            }
        };
        let (px, py) = (i64::from(p.x), i64::from(p.y));
        let inside_grid = px >= self.min_x
            && py >= self.min_y
            && px < self.min_x + self.nx as i64 * CELL
            && py < self.min_y + self.ny as i64 * CELL;
        if inside_grid {
            let (cx, cy) = self.cell_of(px, py);
            let max_r = self.nx.max(self.ny) as i64;
            for r in 0..=max_r {
                for gy in (cy as i64 - r)..=(cy as i64 + r) {
                    for gx in (cx as i64 - r)..=(cx as i64 + r) {
                        // Only the ring of cells at distance r.
                        if (gx - cx as i64).abs().max((gy - cy as i64).abs()) != r {
                            continue;
                        }
                        if gx < 0 || gy < 0 || gx >= self.nx as i64 || gy >= self.ny as i64 {
                            continue;
                        }
                        for &ei in self.cell_edges(gx as usize, gy as usize) {
                            if let Some(e) = self.edges.get(ei as usize) {
                                take(&mut best, ei as usize, e);
                            }
                        }
                    }
                }
                if best.0.is_finite() && best.0.sqrt() <= (r * CELL) as f64 {
                    break;
                }
            }
        }
        if !best.0.is_finite() {
            for (ei, e) in self.edges.iter().enumerate() {
                take(&mut best, ei, e);
            }
        }
        Some((best.0.sqrt() / crate::geom::SCALE, best.1))
    }

    /// Indices of the edges within `r` (internal units) of `p`, each once, in edge order.
    pub(crate) fn within(&self, p: Pt, r: f64) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        if self.edges.is_empty() {
            return out;
        }
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a radius of a few mm in internal units"
        )]
        let ri = r.ceil() as i64;
        let (x0, y0) = self.cell_of(i64::from(p.x) - ri, i64::from(p.y) - ri);
        let (x1, y1) = self.cell_of(i64::from(p.x) + ri, i64::from(p.y) + ri);
        for cy in y0..=y1 {
            for cx in x0..=x1 {
                for &ei in self.cell_edges(cx, cy) {
                    if let Some(e) = self.edges.get(ei as usize)
                        && seg_dist2(p, e) <= r * r
                    {
                        out.push(ei as usize);
                    }
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Edge `i`.
    pub(crate) fn edge(&self, i: usize) -> Option<[Pt; 2]> {
        self.edges.get(i).copied()
    }

    /// Even-odd containment: a ray toward +x, counting each edge once, in the
    /// cell where the edge crosses the ray's row.
    pub(crate) fn inside(&self, p: Pt) -> bool {
        if self.edges.is_empty() {
            return false;
        }
        let (px, py) = (i64::from(p.x), i64::from(p.y));
        if py < self.min_y || px > self.min_x + self.nx as i64 * CELL {
            return false;
        }
        let (cx0, cy) = self.cell_of(px, py);
        let mut inside = false;
        for cx in cx0..self.nx {
            for &ei in self.cell_edges(cx, cy) {
                let Some([a, b]) = self.edges.get(ei as usize) else {
                    continue;
                };
                let (ay, by) = (i64::from(a.y), i64::from(b.y));
                if (ay > py) == (by > py) {
                    continue;
                }
                // x of the crossing, compared to the point, in exact integers.
                let (ax, bx) = (i64::from(a.x), i64::from(b.x));
                let num = (bx - ax) * (py - ay);
                let den = by - ay;
                let x_cross_minus_px = ax * den + num - px * den;
                let right = if den > 0 {
                    x_cross_minus_px > 0
                } else {
                    x_cross_minus_px < 0
                };
                if !right {
                    continue;
                }
                // An edge sits in every cell its bounds touch; count it in the
                // first of those the ray reaches.
                if cx == cx0.max(self.cell_of(ax.min(bx), py).0) {
                    inside = !inside;
                }
            }
        }
        inside
    }

    /// Proper crossings of segment `ab` with the boundary, as `(t, point)`
    /// sorted along the segment.
    pub(crate) fn crossings(&self, a: Pt, b: Pt, out: &mut Vec<(f64, Pt)>) {
        out.clear();
        if self.edges.is_empty() {
            return;
        }
        let (sx0, sy0) = self.cell_of(i64::from(a.x.min(b.x)), i64::from(a.y.min(b.y)));
        let (sx1, sy1) = self.cell_of(i64::from(a.x.max(b.x)), i64::from(a.y.max(b.y)));
        let (lo_x, hi_x, lo_y, hi_y) = (a.x.min(b.x), a.x.max(b.x), a.y.min(b.y), a.y.max(b.y));
        for cy in sy0..=sy1 {
            for cx in sx0..=sx1 {
                for &ei in self.cell_edges(cx, cy) {
                    let Some([c, d]) = self.edges.get(ei as usize) else {
                        continue;
                    };
                    if c.x.max(d.x) < lo_x
                        || c.x.min(d.x) > hi_x
                        || c.y.max(d.y) < lo_y
                        || c.y.min(d.y) > hi_y
                    {
                        continue;
                    }
                    // An edge sits in every cell its bounds touch; test it once,
                    // in the first cell shared with the segment's bounds.
                    let (ex, ey) = self.cell_of(i64::from(c.x.min(d.x)), i64::from(c.y.min(d.y)));
                    if (cx, cy) != (sx0.max(ex), sy0.max(ey)) {
                        continue;
                    }
                    if let Some(hit) = cross(a, b, *c, *d) {
                        out.push(hit);
                    }
                }
            }
        }
        if out.len() > 1 {
            crate::sorting::sort_by(out, |x, y| x.0.total_cmp(&y.0));
        }
    }
}

/// Squared distance from `p` to segment `e`, in internal units.
pub(crate) fn seg_dist2(p: Pt, e: &[Pt; 2]) -> f64 {
    let (px, py) = (f64::from(p.x), f64::from(p.y));
    let (ax, ay) = (f64::from(e[0].x), f64::from(e[0].y));
    let (dx, dy) = (f64::from(e[1].x) - ax, f64::from(e[1].y) - ay);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 {
        (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (cx, cy) = (ax + t * dx, ay + t * dy);
    (px - cx).m_powi(2) + (py - cy).m_powi(2)
}

fn orient(a: Pt, b: Pt, c: Pt) -> i64 {
    let v = (i64::from(b.x) - i64::from(a.x)) * (i64::from(c.y) - i64::from(a.y))
        - (i64::from(b.y) - i64::from(a.y)) * (i64::from(c.x) - i64::from(a.x));
    v.signum()
}

/// Where segment `ab` properly crosses `cd`: the parameter along `ab` and the
/// point, rounded to integer coordinates.
#[allow(
    clippy::cast_possible_truncation,
    reason = "the point lies on a segment of i32 coordinates"
)]
fn cross(a: Pt, b: Pt, c: Pt, d: Pt) -> Option<(f64, Pt)> {
    let (o1, o2, o3, o4) = (orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b));
    if o1 == 0 || o2 == 0 || o3 == 0 || o4 == 0 || o1 == o2 || o3 == o4 {
        return None;
    }
    let (ax, ay) = (f64::from(a.x), f64::from(a.y));
    let (rx, ry) = (f64::from(b.x) - ax, f64::from(b.y) - ay);
    let (sx, sy) = (f64::from(d.x) - f64::from(c.x), f64::from(d.y) - f64::from(c.y));
    let den = rx * sy - ry * sx;
    let t = ((f64::from(c.x) - ax) * sy - (f64::from(c.y) - ay) * sx) / den;
    Some((
        t,
        Pt::new((ax + t * rx).round() as i32, (ay + t * ry).round() as i32),
    ))
}

/// Cuts a path where it crosses `support`, returning the pieces in order
/// with whether each lies outside. The path's first point decides the start.
pub(crate) fn split_polyline(path: &[Pt], support: &Support) -> Vec<(Vec<Pt>, bool)> {
    let Some(&first) = path.first() else {
        return Vec::new();
    };
    let mut inside = support.inside(first);
    let mut pieces: Vec<(Vec<Pt>, bool)> = Vec::new();
    let mut cur: Vec<Pt> = vec![first];
    let mut hits: Vec<(f64, Pt)> = Vec::new();
    for w in path.windows(2) {
        let [a, b] = w else { continue };
        support.crossings(*a, *b, &mut hits);
        for &(_, x) in &hits {
            if cur.last() != Some(&x) {
                cur.push(x);
            }
            if cur.len() >= 2 {
                pieces.push((std::mem::take(&mut cur), !inside));
            }
            cur = vec![x];
            inside = !inside;
        }
        if cur.last() != Some(b) {
            cur.push(*b);
        }
    }
    if cur.len() >= 2 {
        pieces.push((cur, !inside));
    }
    pieces
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Tier {
    support: Arc<Support>,
    /// Speed for this degree, or the wall's own when unset.
    speed: Option<f32>,
    /// Walls at this degree or beyond are labeled overhang walls: those whose bead
    /// hangs completely free (its center is more than half the nozzle past the
    /// layer below), as `OrcaSlicer` labels them.
    label: bool,
}

/// Where the walls of one layer hang over the layer below.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Overhang {
    /// Support region per degree, from the least: only degrees that have a speed
    /// set, then the full overhang (100 percent hanging).
    tiers: Vec<Tier>,
    /// `overhang_reverse`: where a wall counts as steeply overhanging, and whether outer walls stay put.
    reverse: Option<Reverse>,
    /// The bead overhang walls print with: its width in mm and its flow against a flat bead of that width.
    /// The width (mm) and flow of an inner loop's overhang wall bead.
    bead: (f32, f32),
    /// The same for the outer loop's.
    outer_bead: (f32, f32),
}

#[derive(Debug, Clone, PartialEq)]
struct Reverse {
    /// The layer below grown by the threshold less half a line; walls outside it are steep. `None` when the
    /// threshold is zero, which reverses every odd layer.
    limit: Option<Arc<Support>>,
    internal_only: bool,
}

/// A bridge strand (Orca's `bridging_flow`): its width, the spacing between strands, its flow against a flat
/// bead of that width, and whether it is round.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct BridgeBead {
    pub(crate) width: f64,
    pub(crate) spacing: f64,
    pub(crate) flow: f64,
    pub(crate) round: bool,
}

/// The strand for a bridge of nominal width `w` at layer height `h` and `bridge_flow` `ratio`.
/// Thick bridges are round threads `w` times the root of the flow wide, `0.05` mm apart. Flat bridges below
/// a flow of 1 lose the missing area from their width, and their spacing follows the narrower width; one
/// too narrow to stay flat (at or under the layer height) becomes a round thread of the same area at the
/// flat spacing. At a flow of 1 or more a flat strand keeps its width and spacing and carries the flow.
pub(crate) fn bridge_bead(w: f64, h: f64, ratio: f64, thick: bool) -> BridgeBead {
    let ratio = ratio.max(0.0);
    let spacing = |w: f64| (w - h * (1.0 - std::f64::consts::FRAC_PI_4)).max(w * 0.5);
    let round = |d: f64, spacing: f64| BridgeBead {
        width: d,
        spacing,
        flow: std::f64::consts::PI * d * d / 4.0 / crate::gcode::bead_area(d, h),
        round: true,
    };
    if thick {
        let d = w * ratio.sqrt();
        return round(d, d + 0.05);
    }
    if ratio >= 1.0 {
        return BridgeBead {
            width: w,
            spacing: spacing(w),
            flow: ratio,
            round: false,
        };
    }
    let area = crate::gcode::bead_area(w, h);
    let narrow = w - (1.0 - ratio) * area / h;
    if narrow > h {
        BridgeBead {
            width: narrow,
            spacing: spacing(narrow),
            flow: 1.0,
            round: false,
        }
    } else {
        round((4.0 * ratio * area / std::f64::consts::PI).sqrt(), spacing(w))
    }
}

/// Orca's `overhang_flow` (`LayerRegion::bridging_flow` for the perimeter role): the bridge strand of the
/// bridge line width (or the nozzle, round, or the inner wall's, flat) at `bridge_flow`. The width in mm, and
/// the flow against a flat bead of that width at layer height `h`.
pub(crate) fn bead(cfg: &PrintConfig, h: f64) -> (f64, f64) {
    let line = crate::session::bridge_line_width(cfg);
    let w = if cfg.thick_bridges {
        line.unwrap_or(cfg.nozzle_diameter)
    } else {
        line.unwrap_or_else(|| cfg.inner_wall_width())
    };
    let b = bridge_bead(w, h, cfg.bridge_flow, cfg.thick_bridges);
    (b.width, b.flow)
}

/// The bead of an overhang wall piece (a wall piece hanging fully clear of the layer below) on the loop `outer` says.
/// On a Bambu Lab printer whose `bridge_line_width` is not set away from the schema default (the maker's app has no
/// such key), the piece is a flat bead at `bridge_flow` built on the wall width: the inner wall's, whichever loop it
/// belongs to, except that arachne walls print their outer loop's pieces at the outer wall's width. At the default
/// flow of 1 that is a plain wall bead. On other printers with `thick_bridges` off, the piece is the plain bead of its
/// own loop: the outer wall's width on the outer loop, the inner wall's on the others, at the wall flow whatever
/// `bridge_flow` is. A bridge line width set by hand on a Bambu Lab printer and `thick_bridges` keep the bridge strand
/// of [`bead`] on every loop. Only the width changes, not the path.
pub(crate) fn wall_bead(cfg: &PrintConfig, h: f64, outer: bool) -> (f64, f64) {
    if wall_width_bead(cfg) {
        let w = if outer && cfg.arachne_generator() {
            cfg.outer_wall_width()
        } else {
            cfg.inner_wall_width()
        };
        let b = bridge_bead(w, h, cfg.bridge_flow, false);
        return (b.width, b.flow);
    }
    if !cfg.thick_bridges && !crate::firmware::bambu_printer(cfg, cfg.gcode_flavor) {
        let w = if outer {
            cfg.outer_wall_width()
        } else {
            cfg.inner_wall_width()
        };
        return (w, 1.0);
    }
    bead(cfg, h)
}

/// Whether overhang wall pieces print the flat bead built on the wall width of [`wall_bead`]: a Bambu Lab printer,
/// `bridge_line_width` not set away from the schema default, `thick_bridges` off.
fn wall_width_bead(cfg: &PrintConfig) -> bool {
    !cfg.thick_bridges && bambu_wall_bead(cfg)
}

/// A Bambu Lab printer whose `bridge_line_width` is not set away from the schema default: there the comments of an
/// overhang wall piece describe its bead as it prints (see [`raised_wall`]).
fn bambu_wall_bead(cfg: &PrintConfig) -> bool {
    let unset = cfg
        .raw
        .get("bridge_line_width")
        .is_none_or(|v| crate::motion::is_schema_default("bridge_line_width", v));
    unset && crate::firmware::bambu_printer(cfg, cfg.gcode_flavor)
}

/// How the G-code comments draw the bead of an overhang wall piece other than flat at the layer height. On a Bambu
/// Lab printer with no `bridge_line_width` set by hand: taller at a `bridge_flow` above 1 on the flat bead of
/// [`wall_bead`], or round with `thick_bridges`. On other printers: round with `thick_bridges`, whose bead is always
/// the round strand of [`bead`], extra perimeters on overhangs included. None otherwise, when the comments state the
/// bead's own width and the layer height.
pub(crate) fn raised_wall(cfg: &PrintConfig) -> Option<RaisedWall> {
    if !bambu_wall_bead(cfg) {
        let other = !crate::firmware::bambu_printer(cfg, cfg.gcode_flavor);
        return (other && cfg.thick_bridges).then_some(RaisedWall::Round);
    }
    if cfg.thick_bridges {
        Some(RaisedWall::Round)
    } else {
        (cfg.bridge_flow > 1.0).then_some(RaisedWall::Flow(cfg.bridge_flow))
    }
}

/// The width and height, mm, the comments state for an overhang wall bead `w` wide at layer height `h`, drawn as
/// `r` says. At a `bridge_flow` `f` above 1: a bead `f` times taller, as wide as a flat bead of the same area at that
/// height (the area, and so the extrusion, is the same `f` times a flat bead of `w` at `h`). A round thread: as tall
/// as it is wide, the nozzle at a `bridge_flow` of 1.
pub(crate) fn raised_wall_label(w: f64, h: f64, r: RaisedWall) -> (f64, f64) {
    match r {
        RaisedWall::Flow(f) => {
            let tall = h * f;
            (
                f * crate::gcode::bead_area(w, h) / tall + tall * (1.0 - std::f64::consts::FRAC_PI_4),
                tall,
            )
        }
        RaisedWall::Round => (w, w),
    }
}

#[allow(clippy::cast_possible_truncation, reason = "a width and a flow ratio")]
fn bead32((w, flow): (f64, f64)) -> (f32, f32) {
    (w as f32, flow as f32)
}

fn speed_of(v: f64) -> Option<f32> {
    #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
    (v > 0.0).then_some(v as f32)
}

/// The overhangs of the regions of one layer, which all hang over the same layer below. The layer below grown by
/// a distance (the slow, full union part of the work) is worked out once per distance and shared by every region,
/// whatever its filament, and the rest once per wall width and settings; only the clear speed is the filament's
/// own.
pub(crate) struct Overhangs<'b, 'c> {
    below: &'b Shapes,
    h: f64,
    /// The layer below grown by a distance in internal units, and its grid once one is wanted.
    grown: Vec<(i32, Arc<Shapes>, Option<Arc<Support>>)>,
    /// The overhang per wall width and settings, without its clear speed.
    built: Vec<(i32, &'c PrintConfig, Overhang)>,
}

impl<'b, 'c> Overhangs<'b, 'c> {
    /// `below` is the material of the layer below, `h` the layer height in mm.
    pub(crate) fn new(below: &'b Shapes, h: f64) -> Self {
        Self {
            below,
            h,
            grown: Vec::new(),
            built: Vec::new(),
        }
    }

    fn entry(&mut self, delta: i32) -> usize {
        if let Some(i) = self.grown.iter().position(|(d, ..)| *d == delta) {
            return i;
        }
        self.grown
            .push((delta, Arc::new(perimeters::offset(self.below, delta)), None));
        self.grown.len() - 1
    }

    /// The layer below grown by `delta` internal units.
    pub(crate) fn grown(&mut self, delta: i32) -> Arc<Shapes> {
        let i = self.entry(delta);
        self.grown.get(i).map(|(_, g, _)| g.clone()).unwrap_or_default()
    }

    /// The grid of the layer below grown by `delta` internal units.
    fn support(&mut self, delta: i32) -> Arc<Support> {
        let i = self.entry(delta);
        let Some((_, g, s)) = self.grown.get_mut(i) else {
            return Arc::default();
        };
        s.get_or_insert_with(|| Arc::new(Support::new(g))).clone()
    }

    /// The overhang of walls `w` internal units wide, printed with settings `cfg` and filament `slot`.
    pub(crate) fn get(&mut self, w: i32, cfg: &'c PrintConfig, slot: u8) -> Overhang {
        if let Some((.., o)) = self
            .built
            .iter()
            .find(|(bw, bc, _)| *bw == w && std::ptr::eq(*bc, cfg))
        {
            return o.clone().with_clear_speed(cfg, slot);
        }
        let o = Overhang::shared(self, w, cfg);
        self.built.push((w, cfg, o.clone()));
        o.with_clear_speed(cfg, slot)
    }

    /// How many times the layer below was grown.
    #[cfg(test)]
    fn grows(&self) -> usize {
        self.grown.len()
    }
}

impl Overhang {
    /// Everything about the overhang of walls `w` internal units wide with settings `cfg` but the filament's
    /// clear speed ([`Self::with_clear_speed`]).
    #[allow(
        clippy::cast_possible_truncation,
        reason = "offsets are a fraction of a line width"
    )]
    fn shared(below: &mut Overhangs<'_, '_>, w: i32, cfg: &PrintConfig) -> Self {
        let wf = f64::from(w);
        // Orca grows the lower layer by half the nozzle (`generate_lower_polygons_series` and
        // `lower_slices_polygons`), whatever the line width. Overhang walls, whose bead hangs fully clear, print
        // at the clear speed (`overhang_totally_speed`, `quality::clear_speed`); the slowdown on the way out over
        // the edge is worked out point by point (`quality.rs`).
        let tiers = vec![Tier {
            support: below.support(crate::geom::mm(cfg.nozzle_diameter / 2.0)),
            speed: None,
            label: true,
        }];
        let reverse = crate::tower::flag(cfg, "overhang_reverse").then(|| {
            // The threshold is a percent of the line width (or mm); the walls may sit this far past the layer
            // below, less half a line, before the layer counts as steeply overhanging.
            let threshold = match cfg.raw.get("overhang_reverse_threshold") {
                Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => {
                    t.trim()
                        .trim_end_matches('%')
                        .trim()
                        .parse::<f64>()
                        .map_or(0.5, |p| p / 100.0)
                        * wf
                }
                Some(v) => v
                    .as_f64()
                    .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
                    .map_or(0.5 * wf, |mm| mm * crate::geom::SCALE),
                None => 0.5 * wf,
            };
            Reverse {
                limit: (threshold > 1.0).then(|| below.support((threshold - 0.5 * wf).round() as i32)),
                internal_only: crate::tower::flag(cfg, "overhang_reverse_internal_only"),
            }
        });
        Self {
            tiers,
            reverse,
            bead: bead32(wall_bead(cfg, below.h, false)),
            outer_bead: bead32(wall_bead(cfg, below.h, true)),
        }
    }

    /// The overhang with the clear speed of filament `slot` on its fully clear tier.
    fn with_clear_speed(mut self, cfg: &PrintConfig, slot: u8) -> Self {
        if let Some(t) = self.tiers.last_mut() {
            t.speed = speed_of(crate::quality::clear_speed(cfg, slot));
        }
        self
    }

    /// The width (mm) and flow of an overhang wall's bead on the outer loop or an inner one.
    pub(crate) fn bead(&self, outer: bool) -> (f32, f32) {
        if outer { self.outer_bead } else { self.bead }
    }

    /// Whether `overhang_reverse` is on.
    pub(crate) fn reverses(&self) -> bool {
        self.reverse.is_some()
    }

    /// Whether a wall ring hangs far enough past the layer below to turn the layer's walls round.
    pub(crate) fn steep(&self, ring: &[Pt]) -> bool {
        match &self.reverse {
            Some(Reverse { limit: Some(l), .. }) => ring.iter().any(|p| !l.inside(*p)),
            Some(Reverse { limit: None, .. }) => true,
            None => false,
        }
    }

    /// Whether outer walls keep their direction (`overhang_reverse_internal_only`).
    pub(crate) fn keeps_outer(&self) -> bool {
        self.reverse.as_ref().is_some_and(|r| r.internal_only)
    }

    /// True when a wall point has no support: it is more than half a line width past the layer below.
    pub(crate) fn hangs(&self, p: Pt) -> bool {
        self.tiers.last().is_some_and(|t| !t.support.inside(p))
    }

    /// True when pieces of this tier are overhang walls.
    pub(crate) fn labeled(&self, tier: usize) -> bool {
        self.tiers.get(tier).is_some_and(|t| t.label)
    }

    /// Speed for a tier, when one is set.
    pub(crate) fn speed(&self, tier: usize) -> Option<f32> {
        self.tiers.get(tier).and_then(|t| t.speed)
    }

    /// Splits a closed ring, starting at its first point, into pieces in
    /// order: `None` where the wall is supported, `Some(tier)` where it hangs.
    /// None when the ring does not hang anywhere.
    pub(crate) fn split(&self, ring: &[Pt]) -> Option<Vec<(Vec<Pt>, Option<usize>)>> {
        let mut closed = ring.to_vec();
        closed.push(*ring.first()?);
        self.split_path(&closed)
    }

    /// [`Overhang::split`] for an open path, which starts at its first point.
    pub(crate) fn split_path(&self, path: &[Pt]) -> Option<Vec<(Vec<Pt>, Option<usize>)>> {
        let first = &self.tiers.first()?.support;
        let mut pieces: Vec<(Vec<Pt>, Option<usize>)> = split_polyline(path, first)
            .into_iter()
            .map(|(p, out)| (p, out.then_some(0)))
            .collect();
        if !pieces.iter().any(|(_, t)| t.is_some()) {
            return None;
        }
        for (i, tier) in self.tiers.iter().enumerate().skip(1) {
            let mut next = Vec::with_capacity(pieces.len());
            for (p, t) in pieces {
                if t == Some(i - 1) {
                    next.extend(
                        split_polyline(&p, &tier.support)
                            .into_iter()
                            .map(|(q, out)| (q, Some(if out { i } else { i - 1 }))),
                    );
                } else {
                    next.push((p, t));
                }
            }
            pieces = next;
        }
        Some(pieces)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A layer printed with three filaments grows the layer below once, and each filament's overhang is the one
    /// worked out on its own, clear speed included.
    #[test]
    fn regions_on_several_filaments_grow_the_layer_below_once() {
        let sq = |x0: i32, y0: i32, x1: i32, y1: i32| {
            vec![vec![
                IntPoint::new(x0, y0),
                IntPoint::new(x1, y0),
                IntPoint::new(x1, y1),
                IntPoint::new(x0, y1),
            ]]
        };
        let below: Shapes = vec![sq(0, 0, 100_000, 100_000), sq(150_000, 0, 200_000, 60_000)];
        let mut cfg = PrintConfig::default();
        cfg.raw.insert(
            "override_process_overhang_speed".into(),
            serde_json::json!(["1", "0", "1"]),
        );
        cfg.raw.insert(
            "filament_overhang_totally_speed".into(),
            serde_json::json!(["7", "8", "9"]),
        );
        cfg.raw
            .insert("enable_overhang_speed".into(), serde_json::json!(true));
        cfg.raw.insert("overhang_reverse".into(), serde_json::json!(true));
        cfg.raw
            .insert("overhang_reverse_threshold".into(), serde_json::json!("100%"));
        let w = crate::geom::mm(0.42);
        let mut shared = Overhangs::new(&below, 0.2);
        let got: Vec<Overhang> = [1, 2, 3].iter().map(|&slot| shared.get(w, &cfg, slot)).collect();
        // Two distances, half the nozzle and the reverse threshold less half a line, each grown once for the
        // three filaments.
        assert_eq!(shared.grows(), 2);
        let _ = shared.get(w, &cfg, 2);
        assert_eq!(shared.grows(), 2);
        let mut speeds = Vec::new();
        for (slot, o) in [1, 2, 3].into_iter().zip(&got) {
            let mut own = Overhangs::new(&below, 0.2);
            assert_eq!(*o, own.get(w, &cfg, slot), "slot {slot}");
            speeds.push(o.speed(0));
        }
        assert_eq!(speeds[0], Some(7.0));
        assert_eq!(speeds[2], Some(9.0));
        assert_ne!(speeds[1], speeds[0]);
        // The grown layer the extra overhang walls read is the same one.
        let grown = shared.grown(crate::geom::mm(cfg.nozzle_diameter / 2.0));
        assert_eq!(shared.grows(), 2);
        assert_eq!(
            *grown,
            perimeters::offset(&below, crate::geom::mm(cfg.nozzle_diameter / 2.0))
        );
    }

    #[test]
    fn flat_bridge_narrows_below_a_flow_of_one() {
        let b = bridge_bead(0.4, 0.2, 0.95, false);
        assert!((b.width - 0.382_146).abs() < 1e-5, "{b:?}");
        assert!((b.spacing - 0.339_226).abs() < 1e-5, "{b:?}");
        assert!((b.flow - 1.0).abs() < 1e-9 && !b.round);
    }

    #[test]
    fn flat_bridge_keeps_its_spacing_above_one() {
        let b = bridge_bead(0.4, 0.2, 1.1, false);
        assert!(
            (b.width - 0.4).abs() < 1e-9 && (b.spacing - 0.357_080).abs() < 1e-5,
            "{b:?}"
        );
        assert!((b.flow - 1.1).abs() < 1e-9);
    }

    #[test]
    fn thick_bridge_is_a_round_thread() {
        let b = bridge_bead(0.4, 0.2, 0.95, true);
        assert!(b.round && (b.width - 0.4 * 0.95_f64.sqrt()).abs() < 1e-9);
        assert!((b.spacing - b.width - 0.05).abs() < 1e-9);
    }

    #[test]
    fn a_flat_bridge_too_narrow_to_stay_flat_goes_round_at_the_flat_spacing() {
        let b = bridge_bead(0.4, 0.2, 0.3, false);
        let area = crate::gcode::bead_area(0.4, 0.2);
        assert!(
            b.round && (std::f64::consts::PI * b.width * b.width / 4.0 - 0.3 * area).abs() < 1e-9,
            "{b:?}"
        );
        assert!((b.spacing - 0.357_080).abs() < 1e-5);
    }

    #[test]
    fn an_overhang_wall_takes_its_own_loop_width_on_other_printers() {
        let mut cfg = PrintConfig::default();
        cfg.feature_widths.inner_wall = Some(0.45);
        cfg.feature_widths.outer_wall = Some(0.42);
        cfg.raw
            .insert("bridge_line_width".into(), serde_json::json!("100%"));
        // The plain wall bead of the loop, whatever the bridge flow and the wall generator.
        for generator in ["classic", "arachne"] {
            cfg.raw
                .insert("wall_generator".into(), serde_json::json!(generator));
            for flow in [1.0, 0.8, 1.2] {
                cfg.bridge_flow = flow;
                assert_eq!(wall_bead(&cfg, 0.2, true), (0.42, 1.0), "{generator} {flow}");
                assert_eq!(wall_bead(&cfg, 0.2, false), (0.45, 1.0), "{generator} {flow}");
                assert_eq!(raised_wall(&cfg), None);
            }
        }
        // Thick bridges: the round strand of the nozzle, stated as tall as it is wide.
        cfg.thick_bridges = true;
        assert_eq!(raised_wall(&cfg), Some(RaisedWall::Round));
        assert_eq!(wall_bead(&cfg, 0.2, true), bead(&cfg, 0.2));
        assert!((wall_bead(&cfg, 0.2, false).0 - cfg.nozzle_diameter * 1.2_f64.sqrt()).abs() < 1e-9);
    }

    #[test]
    fn an_overhang_wall_takes_the_inner_wall_width_on_bambu_lab_printers() {
        let mut cfg = PrintConfig::default();
        cfg.feature_widths.inner_wall = Some(0.6);
        cfg.raw
            .insert("bridge_line_width".into(), serde_json::json!("100%"));
        cfg.raw
            .insert("printer_model".into(), serde_json::json!("Bambu Lab A1"));
        let (w, flow) = wall_bead(&cfg, 0.2, false);
        assert!((w - 0.6).abs() < 1e-9 && (flow - 1.0).abs() < 1e-9, "{w} {flow}");
        // The key left out reads as the default.
        cfg.raw.remove("bridge_line_width");
        assert!((wall_bead(&cfg, 0.2, false).0 - 0.6).abs() < 1e-9);
        // Set by hand, or thick bridges: the bridge strand.
        cfg.raw
            .insert("bridge_line_width".into(), serde_json::json!(0.35));
        assert_eq!(wall_bead(&cfg, 0.2, false), bead(&cfg, 0.2));
        cfg.raw.remove("bridge_line_width");
        cfg.thick_bridges = true;
        assert_eq!(wall_bead(&cfg, 0.2, false), bead(&cfg, 0.2));
    }

    #[test]
    fn an_arachne_outer_loop_overhang_wall_takes_the_outer_wall_width() {
        let mut cfg = PrintConfig::default();
        cfg.feature_widths.inner_wall = Some(0.45);
        cfg.feature_widths.outer_wall = Some(0.42);
        cfg.raw
            .insert("printer_model".into(), serde_json::json!("Bambu Lab A1"));
        cfg.raw.remove("bridge_line_width");
        let width = |cfg: &PrintConfig, outer: bool| wall_bead(cfg, 0.2, outer).0;
        // Fixed-width walls (the key left out) and aegis: the inner wall's width on both loops.
        for generator in [None, Some("classic"), Some("aegis"), Some("athena")] {
            if let Some(g) = generator {
                cfg.raw.insert("wall_generator".into(), serde_json::json!(g));
            }
            assert!((width(&cfg, true) - 0.45).abs() < 1e-9, "{generator:?}");
            assert!((width(&cfg, false) - 0.45).abs() < 1e-9, "{generator:?}");
        }
        cfg.raw
            .insert("wall_generator".into(), serde_json::json!("arachne"));
        assert!((width(&cfg, true) - 0.42).abs() < 1e-9);
        assert!((width(&cfg, false) - 0.45).abs() < 1e-9);
        // A bridge line width set by hand wins on both loops.
        cfg.raw
            .insert("bridge_line_width".into(), serde_json::json!(0.35));
        assert_eq!(wall_bead(&cfg, 0.2, true), bead(&cfg, 0.2));
        assert!((width(&cfg, true) - 0.35).abs() < 1e-9);
    }

    #[test]
    fn a_raised_overhang_wall_label_keeps_the_bead_area() {
        let (w, h) = raised_wall_label(0.45, 0.2, RaisedWall::Flow(1.2));
        assert!(
            (w - 0.458_584).abs() < 1e-6 && (h - 0.24).abs() < 1e-12,
            "{w} {h}"
        );
        let area = crate::gcode::bead_area(w, h);
        assert!((area - 1.2 * crate::gcode::bead_area(0.45, 0.2)).abs() < 1e-12);
        let mut cfg = PrintConfig {
            bridge_flow: 1.2,
            ..PrintConfig::default()
        };
        // Other printers keep the bridge strand's own label above a flow of 1, and state the round thread of
        // thick bridges as tall as it is wide, whatever the bridge line width.
        assert_eq!(raised_wall(&cfg), None);
        cfg.thick_bridges = true;
        assert_eq!(raised_wall(&cfg), Some(RaisedWall::Round));
        cfg.raw
            .insert("bridge_line_width".into(), serde_json::json!(0.35));
        assert_eq!(raised_wall(&cfg), Some(RaisedWall::Round));
        cfg.raw.remove("bridge_line_width");
        cfg.thick_bridges = false;
        cfg.raw
            .insert("printer_model".into(), serde_json::json!("Bambu Lab A1"));
        cfg.raw.remove("bridge_line_width");
        assert_eq!(raised_wall(&cfg), Some(RaisedWall::Flow(1.2)));
        cfg.bridge_flow = 1.0;
        assert_eq!(raised_wall(&cfg), None);
        cfg.bridge_flow = 1.2;
        cfg.thick_bridges = true;
        assert_eq!(raised_wall(&cfg), Some(RaisedWall::Round));
        cfg.bridge_flow = 1.0;
        assert_eq!(raised_wall(&cfg), Some(RaisedWall::Round));
        cfg.thick_bridges = false;
        cfg.bridge_flow = 1.2;
        cfg.raw
            .insert("bridge_line_width".into(), serde_json::json!(0.35));
        assert_eq!(raised_wall(&cfg), None);
        cfg.thick_bridges = true;
        assert_eq!(raised_wall(&cfg), None);
    }

    #[test]
    fn a_round_overhang_wall_label_is_as_tall_as_it_is_wide() {
        assert_eq!(raised_wall_label(0.4, 0.2, RaisedWall::Round), (0.4, 0.4));
        assert_eq!(raised_wall_label(0.6, 0.3, RaisedWall::Round), (0.6, 0.6));
    }

    fn square(x0: i32, y0: i32, x1: i32, y1: i32) -> Shapes {
        vec![vec![vec![
            Pt::new(x0, y0),
            Pt::new(x1, y0),
            Pt::new(x1, y1),
            Pt::new(x0, y1),
        ]]]
    }

    #[test]
    fn containment_and_crossings() {
        let s = Support::new(&square(0, 0, 100_000, 100_000));
        assert!(s.inside(Pt::new(50_000, 50_000)));
        assert!(!s.inside(Pt::new(150_000, 50_000)));
        assert!(!s.inside(Pt::new(50_000, 150_000)));
        let mut hits = Vec::new();
        s.crossings(Pt::new(-10_000, 50_000), Pt::new(50_000, 50_000), &mut hits);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].1, Pt::new(0, 50_000));
    }

    #[test]
    fn a_ring_half_outside_splits_in_two() {
        // Support covers x < 100_000; the ring spans 50_000 to 150_000.
        let s = Support::new(&square(0, 0, 100_000, 100_000));
        let ring = [
            Pt::new(50_000, 20_000),
            Pt::new(150_000, 20_000),
            Pt::new(150_000, 80_000),
            Pt::new(50_000, 80_000),
        ];
        let mut closed = ring.to_vec();
        closed.push(ring[0]);
        let pieces = split_polyline(&closed, &s);
        assert_eq!(pieces.iter().filter(|p| p.1).count(), 1);
        assert_eq!(pieces.iter().filter(|p| !p.1).count(), 2);
        // Pieces chain end to start and cover the whole ring.
        for w in pieces.windows(2) {
            assert_eq!(w[0].0.last(), w[1].0.first());
        }
        assert_eq!(pieces[0].0.first(), Some(&ring[0]));
        assert_eq!(pieces.last().and_then(|p| p.0.last()), Some(&ring[0]));
    }
}
