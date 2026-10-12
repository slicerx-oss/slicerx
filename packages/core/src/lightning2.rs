// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Lightning infill, second planner (`lightning_engine` = `v2`).
//!
//! Only what holds up a solid layer gets infill. Working from the top layer down, every patch of sparse
//! area with no sparse area right above it (so a skin sits on it) is covered with sample points, and each
//! point is joined to the nearest wall or to a branch already there. Carried one layer down, the trees lose
//! a little of every tip, straighten, and drop what left the outline, so they lean in toward the walls and
//! end on them. Sparse area far below any skin gets nothing.
//!
//! [`Quirks`] holds a switch for each place where the reference slicer's lightning output differs from
//! what it evidently means to do. All off (the default) is the intended behavior; all on
//! ([`Quirks::reference`], the `lightning_parity` setting) reproduces the reference output for parity runs.
//!
//! Lengths are millimeters throughout.

use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::perimeters::{self, Shapes};
use std::collections::HashMap;

type P = [f64; 2];

/// Cell of the lookup grid for nodes near a sample point, mm.
const NODE_CELL: f64 = 4.0;
/// Points closer than this count as the same place, mm.
const SAME: f64 = 1e-4;
/// A node this close to the line through its neighbors counts as on it when straightening, mm.
const ON_LINE: f64 = 1e-5;
/// Seed of the pseudo-random ordering of sample points in one distance band.
const ORDER_MOD: i64 = 191;

/// The places where the reference output departs from its evident intent. Off (the default) does what
/// was meant; on reproduces the reference output.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "one independent switch per behavior difference"
)]
pub(crate) struct Quirks {
    /// A new branch clears only the sample points within the support radius of its new node, not those
    /// along the new edge.
    pub disc_only: bool,
    /// Re-grounding a carried root trusts the wall up to a hair (0.1 micrometer) less than the wall
    /// reach, instead of 0.1 mm less.
    pub hair_margin: bool,
    /// Junctions move by about a micrometer a layer (a unit weight of 0.001 mm) instead of up to three
    /// quarters of the straightening distance (a weight of 1 mm).
    pub stuck_junctions: bool,
    /// The outline crossing used to cut and re-ground branches is the last one found whose predecessor
    /// was nearer, starting from the origin, instead of the true nearest crossing.
    pub loose_crossing: bool,
    /// Each tree's main line follows a child picked by a C-library style random generator instead of
    /// the first child.
    pub random_main: bool,
    /// The wall reach, tip pruning and straightening come from the nominal layer height instead of each
    /// layer's own thickness.
    pub nominal_height: bool,
}

impl Quirks {
    /// Every switch on: the reference output, for parity runs.
    pub(crate) fn reference() -> Self {
        Self {
            disc_only: true,
            hair_margin: true,
            stuck_junctions: true,
            loose_crossing: true,
            random_main: true,
            nominal_height: true,
        }
    }
}

/// Settings of one lightning plan.
#[derive(Debug, Clone)]
pub(crate) struct Params {
    /// Sparse infill line width, mm (already resolved from its fallbacks, never 0).
    pub line_width: f64,
    /// Center distance of neighboring lines, mm (the multi-line copies).
    pub spacing: f64,
    /// How far each line is shortened where it meets a junction, mm.
    pub junction_trim: f64,
    /// Sparse infill density, percent.
    pub density_percent: f64,
    /// Lines per branch (`fill_multiline`), 1 to 10.
    pub lines_per_branch: u32,
    /// The object's nominal layer height, mm.
    pub layer_height: f64,
    /// Thickness of every layer, mm (empty: the nominal height everywhere).
    pub thickness: Vec<f64>,
    /// How far a wall reaches to hold the layer above, degrees from vertical.
    pub overhang_angle: f64,
    /// How fast branch tips are cut back, degrees.
    pub prune_angle: f64,
    /// How far a node may move per layer when straightening, degrees.
    pub straighten_angle: f64,
    pub quirks: Quirks,
}

/// Values derived once from [`Params`].
#[derive(Debug, Clone, Copy)]
struct Derived {
    /// Supporting radius: a branch holds the skin this far around it.
    radius: f64,
    /// Sample pitch over a patch that needs support.
    cell: f64,
    /// Outline crossings this close to the node they are measured from count as near.
    near: f64,
    overhang_tan: f64,
    prune_tan: f64,
    straighten_tan: f64,
}

impl Derived {
    fn new(p: &Params) -> Self {
        let n = f64::from(p.lines_per_branch.clamp(1, 10));
        let radius = p.line_width * 100.0 * n / p.density_percent;
        let cell = radius / 6.0;
        let tan = |deg: f64| deg.clamp(0.0, 89.0).to_radians().m_tan();
        Self {
            radius,
            cell,
            near: 2.0 * cell,
            overhang_tan: tan(p.overhang_angle),
            prune_tan: tan(p.prune_angle),
            straighten_tan: tan(p.straighten_angle),
        }
    }
}

/// Lightning lines of every layer (mm), not yet clipped to each region's area. `areas` holds each layer's
/// sparse infill area, bottom layer first.
pub(crate) fn plan(areas: &[Shapes], p: &Params) -> Vec<Vec<Vec<P>>> {
    let n = areas.len();
    let mut out: Vec<Vec<Vec<P>>> = vec![Vec::new(); n];
    if n == 0
        || p.density_percent.is_nan()
        || p.density_percent <= 0.0
        || p.line_width.is_nan()
        || p.line_width <= 0.0
    {
        return out;
    }
    let d = Derived::new(p);
    let height = |l: usize| -> f64 {
        if p.quirks.nominal_height {
            p.layer_height
        } else {
            p.thickness
                .get(l)
                .copied()
                .filter(|t| *t > 0.0)
                .unwrap_or(p.layer_height)
        }
    };
    #[allow(clippy::cast_possible_truncation, reason = "layer counts fit in u32")]
    let count = n as u32;
    let outlines: Vec<Edges> = crate::par::map_range(0..count, |l| {
        Edges::new(
            areas.get(l as usize).map_or(&[][..], Vec::as_slice),
            d.cell.max(0.25),
        )
    });
    let overhangs: Vec<Shapes> = crate::par::map_range(0..count, |l| {
        let l = l as usize;
        overhang(areas, l, height(l) * d.overhang_tan, d.cell)
    });
    let mut forest = Forest::default();
    let mut rng = CRand::new(1);
    for l in (0..n).rev() {
        let (Some(outline), Some(over)) = (outlines.get(l), overhangs.get(l)) else {
            continue;
        };
        let h = height(l);
        let reach = h * d.overhang_tan;
        let carried = forest.roots.clone();
        let mut grid = NodeGrid::default();
        for (id, node) in forest.nodes.iter().enumerate() {
            if node.live {
                grid.insert(id, node.p);
            }
        }
        let ctx = Ctx {
            outline,
            d,
            quirks: p.quirks,
            reach,
        };
        ctx.grow(&mut forest, &mut grid, over);
        ctx.reconnect(&mut forest, &mut grid, &carried);
        if let Some(slot) = out.get_mut(l) {
            *slot = lines(&forest, p, &mut rng);
        }
        if l > 0 {
            let Some(below) = outlines.get(l - 1) else {
                continue;
            };
            forest = ctx.carry(&forest, below, h * d.prune_tan, h * d.straighten_tan);
        }
    }
    out
}

/// What needs support on layer `l`: the sparse area pulled in by the wall reach, less the sparse area of
/// the layer above (a skin sits on the rest), opened by half a sample pitch to drop slivers.
fn overhang(areas: &[Shapes], l: usize, reach: f64, cell: f64) -> Shapes {
    let Some(here) = areas.get(l) else {
        return Vec::new();
    };
    if here.is_empty() {
        return Vec::new();
    }
    let pulled = if reach > 0.0 {
        perimeters::offset(here, -units(reach))
    } else {
        here.clone()
    };
    let bare = match areas.get(l + 1) {
        Some(above) if !above.is_empty() => perimeters::difference(&pulled, above),
        _ => pulled,
    };
    if bare.is_empty() {
        return bare;
    }
    let half = units(0.5 * cell);
    if half <= 0 {
        return bare;
    }
    let shrunk = perimeters::offset(&bare, -half);
    if shrunk.is_empty() {
        return shrunk;
    }
    perimeters::offset_round(&shrunk, half)
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "lengths on a print bed fit in i32"
)]
fn units(v: f64) -> i32 {
    (v * SCALE).round() as i32
}

fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}

fn len(v: P) -> f64 {
    (v[0] * v[0] + v[1] * v[1]).sqrt()
}

fn dist(a: P, b: P) -> f64 {
    len(sub(a, b))
}

/// `p` moved toward `to` by at most `step`.
fn toward(p: P, to: P, step: f64) -> P {
    let v = sub(to, p);
    let l = len(v);
    if l <= step || l <= 0.0 {
        to
    } else {
        [p[0] + v[0] / l * step, p[1] + v[1] / l * step]
    }
}

/// The point of segment `a`-`b` closest to `p`.
fn seg_closest(p: P, a: P, b: P) -> P {
    let ab = sub(b, a);
    let l2 = ab[0] * ab[0] + ab[1] * ab[1];
    if l2 <= 0.0 {
        return a;
    }
    let t = (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2).clamp(0.0, 1.0);
    [a[0] + ab[0] * t, a[1] + ab[1] * t]
}

fn seg_dist(p: P, a: P, b: P) -> f64 {
    dist(p, seg_closest(p, a, b))
}

/// Distance from `p` to the infinite line through `a` and `b` (to `a` when they coincide).
fn line_dist(p: P, a: P, b: P) -> f64 {
    let ab = sub(b, a);
    let l = len(ab);
    if l <= 0.0 {
        return dist(p, a);
    }
    ((p[0] - a[0]) * ab[1] - (p[1] - a[1]) * ab[0]).abs() / l
}

/// Where segments `a`-`b` and `c`-`e` meet: the parameter along `a`-`b` and the point.
fn seg_cross(a: P, b: P, c: P, e: P) -> Option<(f64, P)> {
    let r = sub(b, a);
    let s = sub(e, c);
    let den = r[0] * s[1] - r[1] * s[0];
    if den.abs() < 1e-18 {
        return None;
    }
    let ca = sub(c, a);
    let t = (ca[0] * s[1] - ca[1] * s[0]) / den;
    let u = (ca[0] * r[1] - ca[1] * r[0]) / den;
    ((-1e-12..=1.0 + 1e-12).contains(&t) && (-1e-12..=1.0 + 1e-12).contains(&u))
        .then(|| (t, [a[0] + r[0] * t, a[1] + r[1] * t]))
}

/// The edges of an outline in a uniform grid: nearest point, inside test, crossings.
struct Edges {
    segs: Vec<(P, P)>,
    cell: f64,
    origin: P,
    cols: i64,
    rows: i64,
    /// Edge ids per cell (every cell an edge's bounding box touches), row-major.
    cells: Vec<Vec<u32>>,
    /// Edge ids per row of cells, for the inside test and scan lines.
    bands: Vec<Vec<u32>>,
}

impl Edges {
    fn new(shapes: &[Vec<Vec<i_overlay::i_float::int::point::IntPoint<i32>>>], cell: f64) -> Self {
        let mut segs = Vec::new();
        for shape in shapes {
            for ring in shape {
                let pts: Vec<P> = ring
                    .iter()
                    .map(|q| [f64::from(q.x) / SCALE, f64::from(q.y) / SCALE])
                    .collect();
                for (i, a) in pts.iter().enumerate() {
                    if let Some(b) = pts.get((i + 1) % pts.len())
                        && dist(*a, *b) > 0.0
                    {
                        segs.push((*a, *b));
                    }
                }
            }
        }
        let mut e = Self {
            segs,
            cell,
            origin: [0.0, 0.0],
            cols: 0,
            rows: 0,
            cells: Vec::new(),
            bands: Vec::new(),
        };
        if e.segs.is_empty() {
            return e;
        }
        let mut lo = [f64::MAX, f64::MAX];
        let mut hi = [f64::MIN, f64::MIN];
        for (a, b) in &e.segs {
            for q in [a, b] {
                lo = [lo[0].min(q[0]), lo[1].min(q[1])];
                hi = [hi[0].max(q[0]), hi[1].max(q[1])];
            }
        }
        e.origin = lo;
        e.cols = e.col(hi[0]) + 1;
        e.rows = e.row(hi[1]) + 1;
        let size = usize::try_from(e.cols * e.rows).unwrap_or(0);
        e.cells = vec![Vec::new(); size];
        e.bands = vec![Vec::new(); usize::try_from(e.rows).unwrap_or(0)];
        for (id, (a, b)) in e.segs.iter().enumerate() {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "an outline has far fewer than 2^32 edges"
            )]
            let id = id as u32;
            let (c0, c1) = (e.col(a[0].min(b[0])), e.col(a[0].max(b[0])));
            let (r0, r1) = (e.row(a[1].min(b[1])), e.row(a[1].max(b[1])));
            for r in r0..=r1 {
                if let Some(band) = usize::try_from(r).ok().and_then(|r| e.bands.get_mut(r)) {
                    band.push(id);
                }
                for c in c0..=c1 {
                    if let Some(slot) = e.slot(c, r).and_then(|s| e.cells.get_mut(s)) {
                        slot.push(id);
                    }
                }
            }
        }
        e
    }

    fn is_empty(&self) -> bool {
        self.segs.is_empty()
    }

    #[allow(clippy::cast_possible_truncation, reason = "grid coordinates on a print bed")]
    fn col(&self, x: f64) -> i64 {
        ((x - self.origin[0]) / self.cell).floor() as i64
    }

    #[allow(clippy::cast_possible_truncation, reason = "grid coordinates on a print bed")]
    fn row(&self, y: f64) -> i64 {
        ((y - self.origin[1]) / self.cell).floor() as i64
    }

    fn slot(&self, c: i64, r: i64) -> Option<usize> {
        (c >= 0 && r >= 0 && c < self.cols && r < self.rows)
            .then(|| usize::try_from(r * self.cols + c).ok())
            .flatten()
    }

    fn seg(&self, id: u32) -> Option<(P, P)> {
        self.segs.get(id as usize).copied()
    }

    /// The point of the outline nearest to `p` and its distance.
    fn closest(&self, p: P) -> Option<(P, f64)> {
        if self.is_empty() {
            return None;
        }
        let cx = self.col(p[0]).clamp(0, self.cols - 1);
        let cy = self.row(p[1]).clamp(0, self.rows - 1);
        // How far `p` lies outside the cell the search starts from.
        #[allow(clippy::cast_precision_loss, reason = "grid coordinates are small")]
        let off = {
            let x0 = self.origin[0] + cx as f64 * self.cell;
            let y0 = self.origin[1] + cy as f64 * self.cell;
            let dx = (x0 - p[0]).max(p[0] - (x0 + self.cell)).max(0.0);
            let dy = (y0 - p[1]).max(p[1] - (y0 + self.cell)).max(0.0);
            dx.m_hypot(dy)
        };
        let mut best: Option<(P, f64)> = None;
        let mut r = 0i64;
        loop {
            for (c, rr) in ring(cx, cy, r) {
                let Some(slot) = self.slot(c, rr).and_then(|s| self.cells.get(s)) else {
                    continue;
                };
                for &id in slot {
                    let Some((a, b)) = self.seg(id) else { continue };
                    let q = seg_closest(p, a, b);
                    let dd = dist(p, q);
                    if best.is_none_or(|(_, bd)| dd < bd) {
                        best = Some((q, dd));
                    }
                }
            }
            #[allow(clippy::cast_precision_loss, reason = "grid coordinates are small")]
            let bound = r as f64 * self.cell - off;
            if best.is_some_and(|(_, bd)| bd <= bound) {
                break;
            }
            if cx - r <= 0 && cy - r <= 0 && cx + r >= self.cols - 1 && cy + r >= self.rows - 1 {
                break;
            }
            r += 1;
        }
        best
    }

    /// Even-odd inside test.
    fn inside(&self, p: P) -> bool {
        let Some(band) = usize::try_from(self.row(p[1]))
            .ok()
            .and_then(|r| self.bands.get(r))
        else {
            return false;
        };
        let mut inside = false;
        for &id in band {
            let Some((a, b)) = self.seg(id) else { continue };
            if (a[1] > p[1]) != (b[1] > p[1]) {
                let x = a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
                if p[0] < x {
                    inside = !inside;
                }
            }
        }
        inside
    }

    /// Inside, or on the outline within [`SAME`].
    fn holds(&self, p: P) -> bool {
        self.inside(p) || self.closest(p).is_some_and(|(_, dd)| dd <= SAME)
    }

    /// Every crossing of segment `a`-`b` with the outline: the parameter along `a`-`b` and the point, in
    /// the order of the outline's edges.
    fn crossings(&self, a: P, b: P) -> Vec<(f64, P)> {
        if self.is_empty() {
            return Vec::new();
        }
        let c0 = self.col(a[0].min(b[0])).max(0);
        let c1 = self.col(a[0].max(b[0])).min(self.cols - 1);
        let r0 = self.row(a[1].min(b[1])).max(0);
        let r1 = self.row(a[1].max(b[1])).min(self.rows - 1);
        let mut ids = Vec::new();
        for r in r0..=r1 {
            for c in c0..=c1 {
                if let Some(slot) = self.slot(c, r).and_then(|s| self.cells.get(s)) {
                    ids.extend_from_slice(slot);
                }
            }
        }
        ids.sort_unstable();
        ids.dedup();
        ids.into_iter()
            .filter_map(|id| self.seg(id).and_then(|(c, e)| seg_cross(a, b, c, e)))
            .collect()
    }

    /// True when segment `a`-`b` crosses the outline away from both of its ends.
    fn cuts(&self, a: P, b: P) -> bool {
        let l = dist(a, b);
        self.crossings(a, b)
            .iter()
            .any(|(t, _)| t * l > SAME && (1.0 - t) * l > SAME)
    }

    /// True when segment `a`-`b` crosses the outline away from its ends within `near` of `b` (by the pick
    /// of [`Self::crossing_near`]).
    fn inner_crossing_near(&self, a: P, b: P, near: f64, loose: bool) -> bool {
        let l = dist(a, b);
        let xs: Vec<(f64, P)> = self
            .crossings(a, b)
            .into_iter()
            .filter(|(t, _)| t * l > SAME && (1.0 - t) * l > SAME)
            .collect();
        Self::pick(xs, b, loose).is_some_and(|x| dist(x, b) <= near)
    }

    /// The crossing of `a`-`b` nearest to `to`, when it lies within `near` of it. With `loose`, the
    /// reference's pick instead: starting from the origin, each crossing replaces the stored one when the
    /// stored one is nearer than the best distance so far.
    fn crossing_near(&self, a: P, b: P, to: P, near: f64, loose: bool) -> Option<P> {
        Self::pick(self.crossings(a, b), to, loose).filter(|x| dist(*x, to) <= near)
    }

    /// The crossing nearest to `to`, or with `loose` the reference's pick.
    fn pick(xs: Vec<(f64, P)>, to: P, loose: bool) -> Option<P> {
        if loose {
            let mut stored: Option<P> = None;
            let mut seen = [0.0, 0.0];
            let mut best = f64::INFINITY;
            for (_, x) in xs {
                let dd = dist(seen, to);
                if dd < best {
                    best = dd;
                    stored = Some(x);
                }
                seen = x;
            }
            stored
        } else {
            xs.into_iter()
                .map(|(_, x)| x)
                .min_by(|x, y| dist(*x, to).total_cmp(&dist(*y, to)))
        }
    }
}

/// The cells at Chebyshev distance `r` around `(cx, cy)`.
fn ring(cx: i64, cy: i64, r: i64) -> Vec<(i64, i64)> {
    if r == 0 {
        return vec![(cx, cy)];
    }
    let mut out = Vec::with_capacity(usize::try_from(8 * r).unwrap_or(0));
    for c in cx - r..=cx + r {
        out.push((c, cy - r));
        out.push((c, cy + r));
    }
    for rr in cy - r + 1..cy + r {
        out.push((cx - r, rr));
        out.push((cx + r, rr));
    }
    out
}

#[derive(Debug, Clone)]
struct Node {
    p: P,
    parent: Option<usize>,
    kids: Vec<usize>,
    /// Where a root last stood on a wall (meaningful on roots only).
    ground: Option<P>,
    live: bool,
}

#[derive(Debug, Clone, Default)]
struct Forest {
    nodes: Vec<Node>,
    roots: Vec<usize>,
}

impl Forest {
    fn add(&mut self, p: P, parent: Option<usize>, ground: Option<P>) -> usize {
        let id = self.nodes.len();
        self.nodes.push(Node {
            p,
            parent,
            kids: Vec::new(),
            ground,
            live: true,
        });
        match parent {
            Some(q) => {
                if let Some(n) = self.nodes.get_mut(q) {
                    n.kids.push(id);
                }
            }
            None => self.roots.push(id),
        }
        id
    }

    fn pos(&self, id: usize) -> P {
        self.nodes.get(id).map_or([0.0, 0.0], |n| n.p)
    }

    fn root_of(&self, mut id: usize) -> usize {
        while let Some(q) = self.nodes.get(id).and_then(|n| n.parent) {
            id = q;
        }
        id
    }

    /// Connections of a node: its children and its parent.
    fn degree(&self, id: usize) -> usize {
        self.nodes
            .get(id)
            .map_or(0, |n| n.kids.len() + usize::from(n.parent.is_some()))
    }

    /// The nodes of the tree under `root`, root first (depth first, children in order).
    fn subtree(&self, root: usize) -> Vec<usize> {
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            out.push(id);
            if let Some(n) = self.nodes.get(id) {
                stack.extend(n.kids.iter().rev());
            }
        }
        out
    }

    /// The node of `root`'s tree nearest to `p` (the first in tree order on a tie).
    fn nearest_in(&self, root: usize, p: P) -> usize {
        let mut best = (root, f64::INFINITY);
        for id in self.subtree(root) {
            let dd = dist(self.pos(id), p);
            if dd < best.1 {
                best = (id, dd);
            }
        }
        best.0
    }

    /// Makes `id` the root of its tree by turning the edges on its path to the old root around. The old
    /// root leaves the root list; the caller decides where the new root goes.
    fn reroot(&mut self, id: usize) {
        let old = self.root_of(id);
        let mut path = vec![id];
        let mut at = id;
        while let Some(q) = self.nodes.get(at).and_then(|n| n.parent) {
            path.push(q);
            at = q;
        }
        for w in path.windows(2) {
            let [c, q] = *w else { continue };
            if let Some(n) = self.nodes.get_mut(q) {
                n.kids.retain(|&k| k != c);
            }
            if let Some(n) = self.nodes.get_mut(c) {
                n.kids.push(q);
            }
        }
        for w in path.windows(2) {
            let [c, q] = *w else { continue };
            if let Some(n) = self.nodes.get_mut(q) {
                n.parent = Some(c);
            }
        }
        if let Some(n) = self.nodes.get_mut(id) {
            n.parent = None;
        }
        self.roots.retain(|&r| r != old);
    }

    /// Hangs the root `child` under `parent`.
    fn hang(&mut self, child: usize, parent: usize) {
        self.roots.retain(|&r| r != child);
        if let Some(n) = self.nodes.get_mut(child) {
            n.parent = Some(parent);
        }
        if let Some(n) = self.nodes.get_mut(parent) {
            n.kids.push(child);
        }
    }
}

/// Node ids by grid cell, for the nearby-node search.
#[derive(Default)]
struct NodeGrid {
    cells: HashMap<(i64, i64), Vec<usize>>,
}

impl NodeGrid {
    #[allow(clippy::cast_possible_truncation, reason = "grid coordinates on a print bed")]
    fn key(p: P) -> (i64, i64) {
        (
            (p[0] / NODE_CELL).floor() as i64,
            (p[1] / NODE_CELL).floor() as i64,
        )
    }

    fn insert(&mut self, id: usize, p: P) {
        self.cells.entry(Self::key(p)).or_default().push(id);
    }
}

/// What a point hangs from.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Hold {
    Wall(P),
    Node(usize),
}

struct Ctx<'a> {
    outline: &'a Edges,
    d: Derived,
    quirks: Quirks,
    /// Wall reach on this layer.
    reach: f64,
}

impl Ctx<'_> {
    /// What `u` should hang from: the nearest wall point when it is within `near`, else the best nearby
    /// node whose edge to `u` stays inside, scored by distance less a bonus for nodes with one to three
    /// connections, when it beats the wall. Nodes of `skip_tree` are left out.
    fn hold(&self, f: &Forest, grid: &NodeGrid, u: P, near: f64, skip_tree: Option<usize>) -> Option<Hold> {
        let (b, wall) = self.outline.closest(u)?;
        if wall < near {
            return Some(Hold::Wall(b));
        }
        let bonus = 4.0 * self.d.radius;
        let mut best: Option<(usize, f64)> = None;
        let mut best_score = wall;
        let (x0, y0) = NodeGrid::key([u[0] - wall, u[1] - wall]);
        let (x1, y1) = NodeGrid::key([u[0] + wall, u[1] + wall]);
        for y in y0..=y1 + 1 {
            for x in x0..=x1 + 1 {
                let Some(ids) = grid.cells.get(&(x, y)) else {
                    continue;
                };
                for &id in ids {
                    let Some(node) = f.nodes.get(id) else { continue };
                    if !node.live {
                        continue;
                    }
                    let deg = f.degree(id);
                    let score = dist(node.p, u) - if (1..=3).contains(&deg) { bonus } else { 0.0 };
                    if score >= best_score {
                        continue;
                    }
                    if skip_tree.is_some_and(|t| f.root_of(id) == t) {
                        continue;
                    }
                    if self.outline.cuts(u, node.p) {
                        continue;
                    }
                    best = Some((id, score));
                    best_score = score;
                }
            }
        }
        Some(best.map_or(Hold::Wall(b), |(id, _)| Hold::Node(id)))
    }

    /// New branches for the patch that needs support on this layer.
    fn grow(&self, f: &mut Forest, grid: &mut NodeGrid, over: &Shapes) {
        if over.is_empty() || self.outline.is_empty() {
            return;
        }
        let mut s = Samples::new(over, self.d.cell, self.d.radius);
        for k in 0..s.order.len() {
            let Some(&i) = s.order.get(k) else { continue };
            let Some(pt) = s.pts.get(i) else { continue };
            if pt.done {
                continue;
            }
            let u = pt.p;
            let Some(hold) = self.hold(f, grid, u, self.reach, None) else {
                break;
            };
            let to = match hold {
                Hold::Node(m) => {
                    let id = f.add(u, Some(m), None);
                    grid.insert(id, u);
                    f.pos(m)
                }
                Hold::Wall(b) => {
                    let r = f.add(b, None, Some(b));
                    grid.insert(r, b);
                    let id = f.add(u, Some(r), None);
                    grid.insert(id, u);
                    b
                }
            };
            if self.quirks.disc_only {
                s.clear(u, u);
            } else {
                s.clear(u, to);
            }
        }
    }

    /// Grounds the trees carried down from the layer above again.
    fn reconnect(&self, f: &mut Forest, grid: &mut NodeGrid, carried: &[usize]) {
        if self.outline.is_empty() {
            return;
        }
        let margin = if self.quirks.hair_margin { 1e-4 } else { 0.1 };
        for &r in carried {
            let Some(node) = f.nodes.get(r) else { continue };
            if node.parent.is_some() || !f.roots.contains(&r) {
                continue;
            }
            let rp = node.p;
            if let Some(g) = node.ground.filter(|g| dist(*g, rp) > SAME)
                && let Some(x) = self
                    .outline
                    .crossing_near(rp, g, g, self.d.near, self.quirks.loose_crossing)
            {
                let id = f.add(x, Some(r), Some(x));
                grid.insert(id, x);
                f.reroot(id);
                f.roots.push(id);
                continue;
            }
            match self.hold(f, grid, rp, self.reach - margin, Some(r)) {
                Some(Hold::Wall(b)) if dist(b, rp) <= SAME => {
                    if let Some(n) = f.nodes.get_mut(r) {
                        n.ground = Some(rp);
                    }
                }
                Some(Hold::Wall(b)) => {
                    let t = f.nearest_in(r, b);
                    f.reroot(t);
                    let w = f.add(b, None, Some(b));
                    grid.insert(w, b);
                    f.hang(t, w);
                }
                Some(Hold::Node(m)) => {
                    let t = f.nearest_in(r, f.pos(m));
                    f.reroot(t);
                    f.hang(t, m);
                }
                None => {}
            }
        }
    }

    /// The trees of this layer carried one layer down: tips pruned by `prune`, chains straightened by
    /// up to `straighten`, and everything outside `below` dropped or cut.
    fn carry(&self, f: &Forest, below: &Edges, prune: f64, straighten: f64) -> Forest {
        let mut f = f.clone();
        if prune > 0.0 {
            prune_tips(&mut f, prune);
        }
        if straighten > 0.0 {
            let weight = if self.quirks.stuck_junctions { 1e-3 } else { 1.0 };
            straighten_trees(&mut f, straighten, weight);
        }
        realign(&f, below, self.d.near, self.quirks.loose_crossing)
    }
}

/// Sample points over the patch that needs support, in the order they are served.
struct Samples {
    pts: Vec<Sample>,
    order: Vec<usize>,
    /// Sample index per grid cell (`usize::MAX` for none), row-major over `cols` by `rows`.
    grid: Vec<usize>,
    origin: P,
    cell: f64,
    cols: i64,
    rows: i64,
    radius: f64,
}

struct Sample {
    p: P,
    done: bool,
}

impl Samples {
    fn new(over: &Shapes, cell: f64, radius: f64) -> Self {
        let edges = Edges::new(over, cell.max(0.25));
        let mut s = Self {
            pts: Vec::new(),
            order: Vec::new(),
            grid: Vec::new(),
            origin: [0.0, 0.0],
            cell,
            cols: 0,
            rows: 0,
            radius,
        };
        if edges.is_empty() || cell.is_nan() || cell <= 0.0 {
            return s;
        }
        let mut lo = [f64::MAX, f64::MAX];
        let mut hi = [f64::MIN, f64::MIN];
        for (a, b) in &edges.segs {
            for q in [a, b] {
                lo = [lo[0].min(q[0]), lo[1].min(q[1])];
                hi = [hi[0].max(q[0]), hi[1].max(q[1])];
            }
        }
        s.origin = lo;
        #[allow(clippy::cast_possible_truncation, reason = "grid sizes on a print bed")]
        {
            s.cols = ((hi[0] - lo[0]) / cell).floor() as i64 + 1;
            s.rows = ((hi[1] - lo[1]) / cell).floor() as i64 + 1;
        }
        s.grid = vec![usize::MAX; usize::try_from(s.cols * s.rows).unwrap_or(0)];
        // (band, scatter, row, column, index) per sample, sorted into the serving order.
        let mut keys: Vec<(i64, i64, i64, i64, usize)> = Vec::new();
        for j in 0..s.rows {
            #[allow(clippy::cast_precision_loss, reason = "grid indices are small")]
            let y = lo[1] + (j as f64 + 0.5) * cell;
            let mut xs: Vec<f64> = Vec::new();
            if let Some(band) = usize::try_from(edges.row(y))
                .ok()
                .and_then(|r| edges.bands.get(r))
            {
                for &id in band {
                    let Some((a, b)) = edges.seg(id) else { continue };
                    if (a[1] > y) != (b[1] > y) {
                        xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
                    }
                }
            }
            xs.sort_by(f64::total_cmp);
            for &[x_in, x_out] in xs.as_chunks::<2>().0 {
                #[allow(clippy::cast_possible_truncation, reason = "grid indices are small")]
                let i0 = ((x_in - lo[0]) / cell - 0.5).ceil().max(0.0) as i64;
                let mut i = i0;
                loop {
                    #[allow(clippy::cast_precision_loss, reason = "grid indices are small")]
                    let x = lo[0] + (i as f64 + 0.5) * cell;
                    if x >= x_out || i >= s.cols {
                        break;
                    }
                    let idx = s.pts.len();
                    let p = [x, y];
                    let boundary = edges.closest(p).map_or(0.0, |(_, dd)| dd);
                    #[allow(clippy::cast_possible_truncation, reason = "distance bands are small")]
                    let band = (boundary / radius).floor() as i64;
                    let scatter =
                        (i.wrapping_mul(73_856_093) ^ j.wrapping_mul(19_349_663)).rem_euclid(ORDER_MOD);
                    keys.push((band, scatter, j, i, idx));
                    s.pts.push(Sample { p, done: false });
                    if let Some(slot) = s.slot(i, j).and_then(|k| s.grid.get_mut(k)) {
                        *slot = idx;
                    }
                    i += 1;
                }
            }
        }
        keys.sort_unstable();
        s.order = keys.into_iter().map(|k| k.4).collect();
        s
    }

    fn slot(&self, i: i64, j: i64) -> Option<usize> {
        (i >= 0 && j >= 0 && i < self.cols && j < self.rows)
            .then(|| usize::try_from(j * self.cols + i).ok())
            .flatten()
    }

    /// Marks every sample within the support radius of segment `a`-`b` as served.
    fn clear(&mut self, a: P, b: P) {
        let r = self.radius;
        #[allow(clippy::cast_possible_truncation, reason = "grid indices are small")]
        let idx = |v: f64, o: f64| ((v - o) / self.cell).floor() as i64;
        let (i0, i1) = (
            idx(a[0].min(b[0]) - r, self.origin[0]),
            idx(a[0].max(b[0]) + r, self.origin[0]),
        );
        let (j0, j1) = (
            idx(a[1].min(b[1]) - r, self.origin[1]),
            idx(a[1].max(b[1]) + r, self.origin[1]),
        );
        for j in j0.max(0)..=j1.min(self.rows - 1) {
            for i in i0.max(0)..=i1.min(self.cols - 1) {
                let Some(&k) = self.slot(i, j).and_then(|s| self.grid.get(s)) else {
                    continue;
                };
                if let Some(pt) = self.pts.get_mut(k)
                    && !pt.done
                    && seg_dist(pt.p, a, b) <= r
                {
                    pt.done = true;
                }
            }
        }
    }
}

/// Live nodes children first (the reverse of a depth-first walk from every root).
fn bottom_up(f: &Forest) -> Vec<usize> {
    let mut order = Vec::new();
    for &r in &f.roots {
        order.extend(f.subtree(r));
    }
    order.reverse();
    order
}

/// Cuts `prune` off every free tip, walking up from the leaves: whole edges shorter than what is left
/// go, and the edge where the length runs out is shortened.
fn prune_tips(f: &mut Forest, prune: f64) {
    let mut left: Vec<Option<f64>> = vec![None; f.nodes.len()];
    for id in bottom_up(f) {
        let Some(node) = f.nodes.get(id) else { continue };
        let here = node.p;
        let kids = node.kids.clone();
        if kids.is_empty() {
            if let Some(slot) = left.get_mut(id) {
                *slot = Some(prune);
            }
            continue;
        }
        let mut keep = Vec::with_capacity(kids.len());
        let mut rest: Option<f64> = None;
        for c in kids {
            let budget = left.get(c).copied().flatten();
            let (Some(b), Some(cn)) = (budget, f.nodes.get_mut(c)) else {
                keep.push(c);
                continue;
            };
            let e = dist(cn.p, here);
            if e <= b {
                cn.live = false;
                rest = Some(rest.map_or(b - e, |r: f64| r.max(b - e)));
            } else {
                cn.p = toward(cn.p, here, b);
                keep.push(c);
            }
        }
        let empty = keep.is_empty();
        if let Some(n) = f.nodes.get_mut(id) {
            n.kids = keep;
        }
        if empty && let Some(slot) = left.get_mut(id) {
            *slot = rest;
        }
    }
    // A root left with no branch holds nothing.
    let gone: Vec<usize> = f
        .roots
        .iter()
        .copied()
        .filter(|&r| f.nodes.get(r).is_none_or(|n| n.kids.is_empty()))
        .collect();
    for r in gone {
        if let Some(n) = f.nodes.get_mut(r) {
            n.live = false;
        }
    }
    f.roots.retain(|&r| f.nodes.get(r).is_some_and(|n| n.live));
}

/// Straightens the chains of single-child nodes between junctions, leaves and roots, drops nodes that sit
/// on a straight run between close neighbors, and moves junctions toward the pull of their neighbors.
fn straighten_trees(f: &mut Forest, step: f64, weight: f64) {
    let anchor = |f: &Forest, id: usize| {
        f.nodes
            .get(id)
            .is_none_or(|n| n.parent.is_none() || n.kids.len() != 1)
    };
    // Every chain: an anchor, the single-child nodes below it, and the anchor that ends it.
    let mut chains: Vec<Vec<usize>> = Vec::new();
    for &r in &f.roots.clone() {
        for a in f.subtree(r) {
            if !anchor(f, a) {
                continue;
            }
            let kids = f.nodes.get(a).map_or_else(Vec::new, |n| n.kids.clone());
            for c in kids {
                let mut chain = vec![a, c];
                let mut at = c;
                while !anchor(f, at) {
                    let Some(&next) = f.nodes.get(at).and_then(|n| n.kids.first()) else {
                        break;
                    };
                    chain.push(next);
                    at = next;
                }
                chains.push(chain);
            }
        }
    }
    let path_len = |f: &Forest, chain: &[usize]| -> f64 {
        chain
            .windows(2)
            .map(|w| match *w {
                [a, b] => dist(f.pos(a), f.pos(b)),
                _ => 0.0,
            })
            .sum()
    };
    // Junction moves, from the positions before straightening. The chains of one anchor are adjacent.
    let mut moves: Vec<(usize, P)> = Vec::new();
    for own in chains.chunk_by(|x, y| x.first() == y.first()) {
        let Some(&j) = own.first().and_then(|c| c.first()) else {
            continue;
        };
        let Some(node) = f.nodes.get(j) else { continue };
        if node.parent.is_none() || node.kids.len() < 2 {
            continue;
        }
        if own.iter().any(|c| path_len(f, c) < step) {
            continue;
        }
        // The anchor above: up the parent chain to the first node that is not a single-child link.
        let mut up = node.parent;
        while let Some(q) = up {
            if anchor(f, q) {
                break;
            }
            up = f.nodes.get(q).and_then(|n| n.parent);
        }
        let here = node.p;
        let unit = |to: P| -> P {
            let v = sub(to, here);
            let l = len(v);
            if l > 0.0 {
                [v[0] / l * weight, v[1] / l * weight]
            } else {
                [0.0, 0.0]
            }
        };
        let mut pull = up.map_or([0.0, 0.0], |q| unit(f.pos(q)));
        for c in own {
            if let Some(&z) = c.last() {
                let u = unit(f.pos(z));
                pull = [pull[0] + u[0], pull[1] + u[1]];
            }
        }
        let l = len(pull);
        let cap = 0.75 * step;
        let pull = if l > cap {
            [pull[0] / l * cap, pull[1] / l * cap]
        } else {
            pull
        };
        moves.push((j, pull));
    }
    for chain in &chains {
        let (Some(&a), Some(&z)) = (chain.first(), chain.last()) else {
            continue;
        };
        let total = path_len(f, chain);
        if total <= 0.0 || chain.len() < 3 {
            continue;
        }
        let (pa, pz) = (f.pos(a), f.pos(z));
        let mut along = 0.0;
        let mut prev = pa;
        let targets: Vec<(usize, P)> = chain
            .iter()
            .skip(1)
            .take(chain.len() - 2)
            .map(|&id| {
                let p = f.pos(id);
                along += dist(prev, p);
                prev = p;
                let t = along / total;
                (id, [pa[0] + (pz[0] - pa[0]) * t, pa[1] + (pz[1] - pa[1]) * t])
            })
            .collect();
        for (id, to) in targets {
            if let Some(n) = f.nodes.get_mut(id) {
                n.p = toward(n.p, to, step);
            }
        }
    }
    for (j, v) in moves {
        if let Some(n) = f.nodes.get_mut(j) {
            n.p = [n.p[0] + v[0], n.p[1] + v[1]];
        }
    }
    // Drop links on a straight run whose neighbors are close.
    for chain in &chains {
        for &id in chain.iter().skip(1).take(chain.len().saturating_sub(2)) {
            let Some(node) = f.nodes.get(id) else { continue };
            let (Some(q), Some(&c)) = (node.parent, node.kids.first()) else {
                continue;
            };
            if !node.live || node.kids.len() != 1 {
                continue;
            }
            let (pq, pc, pn) = (f.pos(q), f.pos(c), node.p);
            if dist(pc, pq) <= step && line_dist(pn, pq, pc) <= ON_LINE {
                if let Some(qn) = f.nodes.get_mut(q) {
                    for k in &mut qn.kids {
                        if *k == id {
                            *k = c;
                        }
                    }
                }
                if let Some(cn) = f.nodes.get_mut(c) {
                    cn.parent = Some(q);
                }
                if let Some(n) = f.nodes.get_mut(id) {
                    n.live = false;
                    n.kids.clear();
                }
            }
        }
    }
}

/// The trees fitted to the outline of the layer below: nodes outside are dropped (each inside child
/// becomes a tree of its own that remembers the dropped node as its ground), and edges leaving the outline
/// near their parent are cut (the child becomes a tree of its own).
fn realign(f: &Forest, below: &Edges, near: f64, loose: bool) -> Forest {
    let mut g = Forest::default();
    // (node in f, parent in g, ground for a new tree)
    let mut stack: Vec<(usize, Option<usize>, Option<P>)> = Vec::new();
    for &r in f.roots.iter().rev() {
        stack.push((r, None, f.nodes.get(r).and_then(|n| n.ground)));
    }
    while let Some((id, parent, ground)) = stack.pop() {
        let Some(node) = f.nodes.get(id) else { continue };
        if !node.live {
            continue;
        }
        if !below.holds(node.p) {
            for &c in node.kids.iter().rev() {
                stack.push((c, None, Some(node.p)));
            }
            continue;
        }
        let m = g.add(node.p, parent, if parent.is_none() { ground } else { None });
        for &c in node.kids.iter().rev() {
            let Some(cn) = f.nodes.get(c) else { continue };
            if below.holds(cn.p) && below.inner_crossing_near(cn.p, node.p, near, loose) {
                stack.push((c, None, None));
                if let Some(mn) = g.nodes.get_mut(m) {
                    mn.ground = None;
                }
            } else {
                stack.push((c, Some(m), None));
            }
        }
    }
    // A root left with no branch holds nothing.
    let lone: Vec<usize> = g
        .roots
        .iter()
        .copied()
        .filter(|&r| g.nodes.get(r).is_none_or(|n| n.kids.is_empty()))
        .collect();
    for r in lone {
        if let Some(n) = g.nodes.get_mut(r) {
            n.live = false;
        }
    }
    g.roots.retain(|&r| g.nodes.get(r).is_some_and(|n| n.live));
    g
}

/// A C-library style linear congruential generator (the multiplier and increment of a common one), for
/// the reference's random main-line pick.
struct CRand(u32);

impl CRand {
    fn new(seed: u32) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(214_013).wrapping_add(2_531_011);
        (self.0 >> 16) & 0x7fff
    }
}

/// The polylines of one layer's trees: from each root a main line down one child to a leaf, every other
/// child starting a line at its parent; lines are shortened where they start at a junction, and with more
/// than one line per branch, copies are laid around them.
fn lines(f: &Forest, p: &Params, rng: &mut CRand) -> Vec<Vec<P>> {
    let mut out: Vec<Vec<P>> = Vec::new();
    for &r in &f.roots {
        let Some(root) = f.nodes.get(r) else { continue };
        if root.kids.is_empty() {
            continue;
        }
        let mut work: Vec<(usize, Vec<P>, bool)> = vec![(r, vec![root.p], false)];
        while let Some((start, mut pts, trim)) = work.pop() {
            let mut at = start;
            while let Some(node) = f.nodes.get(at) {
                if node.kids.is_empty() {
                    break;
                }
                let pick = if p.quirks.random_main {
                    rng.next() as usize % node.kids.len()
                } else {
                    0
                };
                let Some(&main) = node.kids.get(pick) else { break };
                for (k, &c) in node.kids.iter().enumerate() {
                    if k != pick {
                        work.push((c, vec![node.p, f.pos(c)], true));
                    }
                }
                at = main;
                pts.push(f.pos(main));
            }
            if trim {
                pts = trim_start(&pts, p.junction_trim);
            }
            if pts.len() >= 2 {
                out.push(pts);
            }
        }
    }
    let n = p.lines_per_branch.clamp(1, 10);
    if n == 1 || out.is_empty() {
        return out;
    }
    let as_points: Vec<Vec<Point>> = out
        .iter()
        .map(|l| l.iter().map(|q| Point::from_mm(q[0], q[1])).collect())
        .collect();
    let mut all = if n % 2 == 1 { out } else { Vec::new() };
    for k in 1..=n / 2 {
        let off = if n % 2 == 1 {
            f64::from(k) * p.spacing
        } else {
            (f64::from(k) - 0.5) * p.spacing
        };
        for shape in crate::support::stroke(&as_points, off) {
            for ring in shape {
                let mut l: Vec<P> = ring
                    .iter()
                    .map(|q| [f64::from(q.x) / SCALE, f64::from(q.y) / SCALE])
                    .collect();
                if let Some(&first) = l.first() {
                    l.push(first);
                }
                if l.len() >= 3 {
                    all.push(l);
                }
            }
        }
    }
    all
}

/// `pts` with `cut` taken off its start; empty when the line is no longer than that.
fn trim_start(pts: &[P], cut: f64) -> Vec<P> {
    if cut <= 0.0 {
        return pts.to_vec();
    }
    let mut left = cut;
    for (i, w) in pts.windows(2).enumerate() {
        let [a, b] = *w else { continue };
        let e = dist(a, b);
        if e > left {
            let mut out = vec![toward(a, b, left)];
            out.extend_from_slice(pts.get(i + 1..).unwrap_or(&[]));
            return out;
        }
        left -= e;
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let p = |x: f64, y: f64| IntPoint::new(units(x), units(y));
        vec![vec![vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]]]
    }

    fn ring_hole(o: (f64, f64, f64, f64), h: (f64, f64, f64, f64)) -> Shapes {
        let p = |x: f64, y: f64| IntPoint::new(units(x), units(y));
        vec![vec![
            vec![p(o.0, o.1), p(o.2, o.1), p(o.2, o.3), p(o.0, o.3)],
            vec![p(h.0, h.1), p(h.0, h.3), p(h.2, h.3), p(h.2, h.1)],
        ]]
    }

    fn params() -> Params {
        Params {
            line_width: 0.45,
            spacing: 0.45,
            junction_trim: 0.2,
            density_percent: 15.0,
            lines_per_branch: 1,
            layer_height: 0.2,
            thickness: Vec::new(),
            overhang_angle: 45.0,
            prune_angle: 45.0,
            straighten_angle: 45.0,
            quirks: Quirks::default(),
        }
    }

    /// A closed box: `layers` layers of a square sparse area, the top `top` of them solid (no sparse area).
    fn closed_box(size: f64, layers: usize, top: usize) -> Vec<Shapes> {
        (0..layers)
            .map(|l| {
                if l + top >= layers {
                    Vec::new()
                } else {
                    rect(2.0, 2.0, size - 2.0, size - 2.0)
                }
            })
            .collect()
    }

    fn length(lines: &[Vec<P>]) -> f64 {
        lines
            .iter()
            .map(|l| l.windows(2).map(|w| dist(w[0], w[1])).sum::<f64>())
            .sum()
    }

    fn near_line(q: P, lines: &[Vec<P>]) -> f64 {
        lines
            .iter()
            .flat_map(|l| l.windows(2).map(move |w| seg_dist(q, w[0], w[1])))
            .fold(f64::INFINITY, f64::min)
    }

    #[test]
    fn the_derived_values_follow_the_settings() {
        let d = Derived::new(&params());
        assert!((d.radius - 3.0).abs() < 1e-9, "{}", d.radius);
        assert!((d.cell - 0.5).abs() < 1e-9);
        assert!((0.2 * d.overhang_tan - 0.2).abs() < 1e-9);
        let d2 = Derived::new(&Params {
            lines_per_branch: 2,
            density_percent: 30.0,
            ..params()
        });
        assert!((d2.radius - 3.0).abs() < 1e-9);
    }

    #[test]
    fn nothing_without_density_or_area() {
        let areas = closed_box(40.0, 50, 4);
        assert!(
            plan(
                &areas,
                &Params {
                    density_percent: 0.0,
                    ..params()
                }
            )
            .iter()
            .all(Vec::is_empty)
        );
        assert!(plan(&[], &params()).is_empty());
        // Sparse area on every layer: only the top layer has nothing above it, and its trees die out
        // well before the bottom.
        let tall: Vec<Shapes> = (0..200).map(|_| rect(2.0, 2.0, 38.0, 38.0)).collect();
        let out = plan(&tall, &params());
        assert!(!out[199].is_empty());
        assert!(
            out.iter().take(50).all(Vec::is_empty),
            "lines far below the only skin"
        );
    }

    #[test]
    fn the_layer_under_the_skin_is_held_everywhere() {
        let areas = closed_box(40.0, 60, 4);
        let out = plan(&areas, &params());
        let under = &out[55];
        assert!(!under.is_empty());
        let mut worst = 0.0f64;
        let mut y: f64 = 2.0;
        while y <= 38.0 {
            let mut x: f64 = 2.0;
            while x <= 38.0 {
                let wall = (x - 2.0).min(38.0 - x).min(y - 2.0).min(38.0 - y);
                worst = worst.max(near_line([x, y], under).min(wall));
                x += 0.5;
            }
            y += 0.5;
        }
        assert!(worst <= 3.0 + 0.3, "a point {worst} mm from any line or wall");
    }

    #[test]
    fn the_lines_die_out_well_above_the_bottom() {
        let areas = closed_box(40.0, 200, 4);
        let out = plan(&areas, &params());
        let lowest = out.iter().position(|l| !l.is_empty()).unwrap();
        assert!(lowest > 50, "lines reach down to layer {lowest}");
        // Going down, the total length never grows (no new skins below the top).
        let lens: Vec<f64> = out.iter().map(|l| length(l)).collect();
        for l in lowest..195 {
            assert!(
                lens[l] <= lens[l + 1] + 1e-6,
                "layer {l} grew: {} > {}",
                lens[l],
                lens[l + 1]
            );
        }
    }

    #[test]
    fn every_line_stays_inside_the_area() {
        let areas = closed_box(40.0, 80, 4);
        let out = plan(&areas, &params());
        for (l, lines) in out.iter().enumerate() {
            for line in lines {
                for q in line {
                    assert!(
                        q[0] >= 2.0 - 0.01 && q[0] <= 38.01 && q[1] >= 1.99 && q[1] <= 38.01,
                        "layer {l}: {q:?} outside"
                    );
                }
            }
        }
    }

    #[test]
    fn the_same_input_gives_the_same_lines() {
        let areas = closed_box(40.0, 60, 4);
        assert_eq!(plan(&areas, &params()), plan(&areas, &params()));
        let q = Params {
            quirks: Quirks::reference(),
            ..params()
        };
        assert_eq!(plan(&areas, &q), plan(&areas, &q));
    }

    #[test]
    fn a_lower_density_needs_fewer_branches() {
        let areas = closed_box(40.0, 30, 4);
        let tips = |pct: f64| {
            let out = plan(
                &areas,
                &Params {
                    density_percent: pct,
                    ..params()
                },
            );
            out[25].len()
        };
        let (a, b, c) = (tips(5.0), tips(15.0), tips(50.0));
        assert!(a < b && b < c, "{a} {b} {c}");
    }

    #[test]
    fn a_wider_wall_reach_leaves_less_to_hold() {
        let areas = closed_box(40.0, 30, 4);
        let len_at = |deg: f64| {
            length(
                &plan(
                    &areas,
                    &Params {
                        overhang_angle: deg,
                        ..params()
                    },
                )[25],
            )
        };
        assert!(len_at(70.0) < len_at(20.0));
    }

    #[test]
    fn clearing_along_the_edge_serves_more_than_the_disc() {
        let areas = closed_box(40.0, 10, 4);
        let along = plan(&areas, &params())[5].len();
        let disc = plan(
            &areas,
            &Params {
                quirks: Quirks {
                    disc_only: true,
                    ..Quirks::default()
                },
                ..params()
            },
        )[5]
        .len();
        assert!(along <= disc, "{along} {disc}");
    }

    #[test]
    fn a_lone_tip_shrinks_by_the_prune_length() {
        let mut f = Forest::default();
        let r = f.add([0.0, 0.0], None, Some([0.0, 0.0]));
        f.add([5.0, 0.0], Some(r), None);
        prune_tips(&mut f, 0.2);
        assert!((f.pos(1)[0] - 4.8).abs() < 1e-9, "{:?}", f.pos(1));
        prune_tips(&mut f, 0.2);
        assert!((f.pos(1)[0] - 4.6).abs() < 1e-9);
    }

    #[test]
    fn pruning_drops_short_edges_and_walks_on() {
        let mut f = Forest::default();
        let r = f.add([0.0, 0.0], None, None);
        let a = f.add([1.0, 0.0], Some(r), None);
        let b = f.add([1.1, 0.0], Some(a), None);
        prune_tips(&mut f, 0.3);
        assert!(!f.nodes[b].live);
        assert!((f.pos(a)[0] - 0.8).abs() < 1e-9, "{:?}", f.pos(a));
    }

    #[test]
    fn a_bent_chain_straightens_by_at_most_the_step() {
        let mut f = Forest::default();
        let r = f.add([0.0, 0.0], None, None);
        let m = f.add([1.0, 1.0], Some(r), None);
        f.add([2.0, 0.0], Some(m), None);
        straighten_trees(&mut f, 0.2, 1.0);
        let p = f.pos(m);
        assert!((p[1] - 0.8).abs() < 1e-9 && (p[0] - 1.0).abs() < 1e-9, "{p:?}");
    }

    #[test]
    fn junctions_move_only_with_the_full_weight() {
        let build = || {
            let mut f = Forest::default();
            let r = f.add([0.0, 0.0], None, None);
            let j = f.add([0.0, 5.0], Some(r), None);
            f.add([-5.0, 6.0], Some(j), None);
            f.add([5.0, 6.0], Some(j), None);
            (f, j)
        };
        let (mut f, j) = build();
        straighten_trees(&mut f, 0.2, 1.0);
        let moved = dist(f.pos(j), [0.0, 5.0]);
        assert!((moved - 0.15).abs() < 1e-9, "{moved}");
        let (mut f, j) = build();
        straighten_trees(&mut f, 0.2, 1e-3);
        assert!(dist(f.pos(j), [0.0, 5.0]) <= 0.003);
    }

    #[test]
    fn realigning_splits_at_dropped_nodes() {
        let mut f = Forest::default();
        let r = f.add([1.0, 5.0], None, Some([1.0, 5.0]));
        let a = f.add([5.0, 5.0], Some(r), None);
        f.add([5.0, 8.0], Some(a), None);
        f.add([8.0, 5.0], Some(a), None);
        // The outline below lost the left strip, so the root falls outside.
        let below = Edges::new(&rect(2.0, 0.0, 10.0, 10.0), 0.5);
        let g = realign(&f, &below, 1.0, false);
        assert_eq!(g.roots.len(), 1);
        let root = &g.nodes[g.roots[0]];
        assert!(dist(root.p, [5.0, 5.0]) < 1e-12);
        assert_eq!(root.ground, Some([1.0, 5.0]));
    }

    #[test]
    fn a_carried_root_is_grounded_where_its_edge_meets_the_wall() {
        let outline = Edges::new(&rect(2.0, 0.0, 10.0, 10.0), 0.5);
        let mut f = Forest::default();
        let r = f.add([5.0, 5.0], None, Some([1.0, 5.0]));
        f.add([6.0, 8.0], Some(r), None);
        let mut grid = NodeGrid::default();
        let ctx = Ctx {
            outline: &outline,
            d: Derived::new(&params()),
            quirks: Quirks::default(),
            reach: 0.2,
        };
        ctx.reconnect(&mut f, &mut grid, &[r]);
        assert_eq!(f.roots.len(), 1);
        let root = &f.nodes[f.roots[0]];
        assert!(dist(root.p, [2.0, 5.0]) < 1e-9, "{:?}", root.p);
        assert_eq!(root.kids, vec![r]);
    }

    #[test]
    fn a_floating_root_hangs_from_the_nearest_wall() {
        let outline = Edges::new(&rect(0.0, 0.0, 20.0, 20.0), 0.5);
        let mut f = Forest::default();
        let r = f.add([10.0, 3.0], None, None);
        f.add([10.0, 8.0], Some(r), None);
        let mut grid = NodeGrid::default();
        grid.insert(0, [10.0, 3.0]);
        grid.insert(1, [10.0, 8.0]);
        let ctx = Ctx {
            outline: &outline,
            d: Derived::new(&params()),
            quirks: Quirks::default(),
            reach: 0.2,
        };
        ctx.reconnect(&mut f, &mut grid, &[r]);
        let root = &f.nodes[f.roots[0]];
        assert!(dist(root.p, [10.0, 0.0]) < 1e-9, "{:?}", root.p);
        assert_eq!(root.kids, vec![r]);
    }

    #[test]
    fn a_ring_top_puts_no_line_across_the_hole() {
        let areas: Vec<Shapes> = (0..40)
            .map(|l| {
                if l >= 36 {
                    Vec::new()
                } else {
                    ring_hole((2.0, 2.0, 38.0, 38.0), (14.0, 14.0, 26.0, 26.0))
                }
            })
            .collect();
        let hole = Edges::new(&rect(14.0, 14.0, 26.0, 26.0), 0.5);
        let out = plan(&areas, &params());
        assert!(!out[35].is_empty());
        for lines in &out {
            for l in lines {
                for w in l.windows(2) {
                    let mid = [f64::midpoint(w[0][0], w[1][0]), f64::midpoint(w[0][1], w[1][1])];
                    assert!(
                        !hole.inside(mid) || hole.closest(mid).unwrap().1 < 1e-6,
                        "{w:?} crosses the hole"
                    );
                }
            }
        }
    }

    #[test]
    fn junction_lines_are_trimmed_and_tiny_ones_dropped() {
        assert!(trim_start(&[[0.0, 0.0], [0.1, 0.0]], 0.2).is_empty());
        let t = trim_start(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]], 0.25);
        assert!((t[0][0] - 0.25).abs() < 1e-12 && t.len() == 3);
    }

    #[test]
    fn more_lines_per_branch_lay_copies_around_each_line() {
        let areas = closed_box(40.0, 12, 4);
        let one = plan(
            &areas,
            &Params {
                lines_per_branch: 1,
                density_percent: 15.0,
                ..params()
            },
        );
        let three = plan(
            &areas,
            &Params {
                lines_per_branch: 3,
                density_percent: 45.0,
                ..params()
            },
        );
        let two = plan(
            &areas,
            &Params {
                lines_per_branch: 2,
                density_percent: 30.0,
                ..params()
            },
        );
        assert!(length(&three[7]) > 2.5 * length(&one[7]));
        // Even counts have no center line: every copy lies half a spacing or more from the trees.
        assert!(!two[7].is_empty());
    }

    #[test]
    fn the_crossing_helpers_agree_on_a_square() {
        let e = Edges::new(&rect(0.0, 0.0, 10.0, 10.0), 1.0);
        assert!(e.inside([5.0, 5.0]) && !e.inside([11.0, 5.0]));
        assert!(e.cuts([5.0, 5.0], [15.0, 5.0]) && !e.cuts([1.0, 1.0], [9.0, 9.0]));
        let x = e
            .crossing_near([5.0, 5.0], [15.0, 5.0], [15.0, 5.0], 6.0, false)
            .unwrap();
        assert!(dist(x, [10.0, 5.0]) < 1e-9);
        assert!(
            e.crossing_near([5.0, 5.0], [15.0, 5.0], [15.0, 5.0], 4.0, false)
                .is_none()
        );
        let (q, dd) = e.closest([3.0, 4.0]).unwrap();
        assert!((dd - 3.0).abs() < 1e-9 && dist(q, [0.0, 4.0]) < 1e-9);
        let (_, far) = e.closest([30.0, 5.0]).unwrap();
        assert!((far - 20.0).abs() < 1e-9);
    }
}
