// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Lightning infill: branching trees of lines that hold up only the parts of the layer above that
//! need it, instead of a pattern over the whole area. The method is the one of Cura's lightning
//! infill (Ultimaker, 2021), which `OrcaSlicer` follows:
//!
//! 1. Going from the top layer down, the part of a layer's sparse area that nothing above holds up
//!    (more than `wall_supporting_radius` away from a wall and not under the layer above's sparse
//!    area) is an overhang.
//! 2. A grid of points over the overhang is to be supported. Taking the points in an order that
//!    starts near the overhang's edge, each one is joined to the best spot: a node of an existing
//!    tree (preferring nodes that have few branches) or the closest point of the outline, and all
//!    points within `supporting_radius` of the new leaf count as supported.
//! 3. The trees go down to the next layer, where their ends are pruned a little, the branches
//!    straightened toward each other, and whatever would leave the outline is cut loose and
//!    reconnected.
//!
//! Lengths are in mm here.

use crate::fm::Fm as _;
use crate::geom::SCALE;
use crate::perimeters::{self, Shapes};
use std::collections::HashMap;

type P = [f64; 2];

/// A cell of the grid the trees are located by, mm.
const LOCATOR_CELL: f64 = 4.0;
/// The distance field's cells are this many to a supporting radius.
const RADIUS_PER_CELL: f64 = 6.0;

fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}
fn len(a: P) -> f64 {
    a[0].m_hypot(a[1])
}
fn dist(a: P, b: P) -> f64 {
    len(sub(a, b))
}

/// Settings of one run.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Params {
    pub(crate) line_width: f64,
    /// Each joint of the lines is pulled back by this much (half the line spacing, `Fill::overlap` being 0).
    pub(crate) joint_overlap: f64,
    pub(crate) density_percent: f64,
    pub(crate) layer_height: f64,
    /// Degrees: `lightning_overhang_angle`, `lightning_prune_angle`, `lightning_straightening_angle`.
    pub(crate) overhang_angle: f64,
    pub(crate) prune_angle: f64,
    pub(crate) straighten_angle: f64,
}

#[derive(Debug, Clone)]
struct Node {
    p: P,
    parent: Option<usize>,
    children: Vec<usize>,
    root: bool,
    ground: Option<P>,
}

/// The trees of one layer.
#[derive(Debug, Clone, Default)]
struct Forest {
    nodes: Vec<Node>,
    roots: Vec<usize>,
}

/// Where the edges of a layer's outline are, for distance and crossing queries.
struct Outline {
    edges: Vec<(P, P)>,
    cells: HashMap<(i64, i64), Vec<usize>>,
    rings: Vec<Vec<P>>,
    /// Orca's edge grid over the same rings, which its crossing queries walk.
    grid: EdgeGrid,
}

fn cell_of(p: P) -> (i64, i64) {
    #[allow(clippy::cast_possible_truncation, reason = "cell indexes are small")]
    (
        (p[0] / LOCATOR_CELL).floor() as i64,
        (p[1] / LOCATOR_CELL).floor() as i64,
    )
}

fn to_mm(shapes: &Shapes) -> Vec<Vec<P>> {
    shapes
        .iter()
        .flat_map(|s| s.iter())
        .map(|r| {
            r.iter()
                .map(|p| [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE])
                .collect()
        })
        .collect()
}

impl Outline {
    fn new(shapes: &Shapes, seed: Option<[i64; 4]>) -> Self {
        let rings = to_mm(shapes);
        let mut edges = Vec::new();
        let mut cells: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
        for ring in &rings {
            let n = ring.len();
            for k in 0..n {
                let (Some(&a), Some(&b)) = (ring.get(k), ring.get((k + 1) % n)) else {
                    continue;
                };
                let idx = edges.len();
                edges.push((a, b));
                let (ca, cb) = (cell_of(a), cell_of(b));
                for cx in ca.0.min(cb.0)..=ca.0.max(cb.0) {
                    for cy in ca.1.min(cb.1)..=ca.1.max(cb.1) {
                        cells.entry((cx, cy)).or_default().push(idx);
                    }
                }
            }
        }
        let grid = EdgeGrid::new(&rings, seed);
        Self {
            edges,
            cells,
            rings,
            grid,
        }
    }

    fn is_empty(&self) -> bool {
        self.edges.is_empty()
    }

    /// Even-odd inside test over every ring.
    fn inside(&self, p: P) -> bool {
        let mut inside = false;
        for ring in &self.rings {
            let n = ring.len();
            for k in 0..n {
                let (Some(&a), Some(&b)) = (ring.get(k), ring.get((k + 1) % n)) else {
                    continue;
                };
                if (a[1] > p[1]) != (b[1] > p[1])
                    && p[0] < a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0])
                {
                    inside = !inside;
                }
            }
        }
        inside
    }

    /// The closest point of the outline to `p` (every edge is tried, as Orca does).
    fn closest(&self, p: P) -> Option<P> {
        let mut best: Option<(f64, P)> = None;
        for &(a, b) in &self.edges {
            let q = closest_on_segment(p, a, b);
            let d = dist(p, q);
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, q));
            }
        }
        best.map(|(_, q)| q)
    }

    /// Edges that may touch the segment `a` to `b`.
    fn near_segment(&self, a: P, b: P) -> Vec<usize> {
        let (ca, cb) = (cell_of(a), cell_of(b));
        let mut out: Vec<usize> = Vec::new();
        for cx in ca.0.min(cb.0)..=ca.0.max(cb.0) {
            for cy in ca.1.min(cb.1)..=ca.1.max(cb.1) {
                if let Some(v) = self.cells.get(&(cx, cy)) {
                    out.extend_from_slice(v);
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Whether the segment crosses the outline.
    fn collides(&self, a: P, b: P) -> bool {
        self.near_segment(a, b).into_iter().any(|e| {
            self.edges
                .get(e)
                .is_some_and(|&(c, d)| segment_intersection(a, b, c, d).is_some())
        })
    }

    /// Orca's `lineSegmentPolygonsIntersection`, quirk included: the intersection it compares against is the
    /// one found before (the first test starts from a zero point), so a crossing counts only when more than
    /// one cell of the grid along the segment holds an edge that crosses it, the last test being measured
    /// from the point found by the one before. A branch crossing the outline once, in one cell, is kept.
    fn crossing_near_end(&self, a: P, b: P, within: f64) -> Option<P> {
        self.grid.crossing_near_end(a, b, within)
    }
}

/// Orca's `EdgeGrid::Grid` of a layer's outline: square cells of `LOCATOR_CELL` over the box of everything seen
/// so far, each holding the edges that pass through it, in the order of the rings. Coordinates in 1e-6 mm.
struct EdgeGrid {
    min: [i64; 2],
    res: i64,
    cols: i64,
    rows: i64,
    cells: Vec<Vec<usize>>,
    edges: Vec<([i64; 2], [i64; 2])>,
    /// The grid's box (min x, min y, max x, max y), kept for the grid of the next layer down.
    bbox: Option<[i64; 4]>,
}

const UNITS: f64 = 1_000_000.0;
/// Orca's `across` test compares a product of two lengths in 1e-6 mm to 1; here lengths are in mm.
const UNITS_PER_MM: f64 = 1.0;

fn to_units(p: P) -> [i64; 2] {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "plate coordinates in millionths of a mm"
    )]
    [(p[0] * UNITS).round() as i64, (p[1] * UNITS).round() as i64]
}

impl EdgeGrid {
    fn new(rings: &[Vec<P>], seed: Option<[i64; 4]>) -> Self {
        let res = to_units([LOCATOR_CELL, 0.0])[0];
        let mut bbox = seed;
        for ring in rings {
            for &p in ring {
                let u = to_units(p);
                bbox = Some(match bbox {
                    None => [u[0], u[1], u[0], u[1]],
                    Some(b) => [b[0].min(u[0]), b[1].min(u[1]), b[2].max(u[0]), b[3].max(u[1])],
                });
            }
        }
        // Everything is moved out by 16 units, as `create_from_m_contours` does.
        let bbox = bbox.map(|b| [b[0] - 16, b[1] - 16, b[2] + 16, b[3] + 16]);
        let Some(b) = bbox else {
            return Self {
                min: [0, 0],
                res,
                cols: 0,
                rows: 0,
                cells: Vec::new(),
                edges: Vec::new(),
                bbox: None,
            };
        };
        let (cols, rows) = ((b[2] - b[0] + res - 1) / res, (b[3] - b[1] + res - 1) / res);
        let mut grid = Self {
            min: [b[0], b[1]],
            res,
            cols,
            rows,
            cells: vec![Vec::new(); usize::try_from(cols * rows).unwrap_or(0)],
            edges: Vec::new(),
            bbox,
        };
        for ring in rings {
            let n = ring.len();
            for k in 0..n {
                let (Some(&p), Some(&q)) = (ring.get(k), ring.get((k + 1) % n)) else {
                    continue;
                };
                grid.edges.push((to_units(p), to_units(q)));
            }
        }
        for e in 0..grid.edges.len() {
            let Some(&(p, q)) = grid.edges.get(e) else {
                continue;
            };
            let mut hit: Vec<usize> = Vec::new();
            let cols = grid.cols;
            grid.walk(p, q, &mut |iy, ix| {
                if let Ok(c) = usize::try_from(iy * cols + ix) {
                    hit.push(c);
                }
                true
            });
            for c in hit {
                if let Some(cell) = grid.cells.get_mut(c) {
                    cell.push(e);
                }
            }
        }
        grid
    }

    /// `visit_cells_intersecting_line`: the cells (row, column) a segment passes, in order, until `visit`
    /// returns false.
    #[allow(
        clippy::comparison_chain,
        reason = "a port of the cell walk, which compares in this order"
    )]
    fn walk(&self, a: [i64; 2], b: [i64; 2], visit: &mut dyn FnMut(i64, i64) -> bool) {
        let res = self.res;
        let (p1, p2) = (
            [a[0] - self.min[0], a[1] - self.min[1]],
            [b[0] - self.min[0], b[1] - self.min[1]],
        );
        let (mut ix, mut iy) = (p1[0] / res, p1[1] / res);
        let (ixb, iyb) = (p2[0] / res, p2[1] / res);
        if !visit(iy, ix) || (ix == ixb && iy == iyb) {
            return;
        }
        let (dx, dy) = ((p2[0] - p1[0]).abs(), (p2[1] - p1[1]).abs());
        let outside = |ix: i64, iy: i64| ix < 0 || iy < 0 || ix >= self.cols || iy >= self.rows;
        if p1[0] < p2[0] {
            let mut ex = ((ix + 1) * res - p1[0]) * dy;
            if p1[1] < p2[1] {
                let mut ey = ((iy + 1) * res - p1[1]) * dx;
                loop {
                    if ex < ey {
                        ey -= ex;
                        ex = dy * res;
                        ix += 1;
                    } else if ex == ey {
                        ex = dy * res;
                        ey = dx * res;
                        ix += 1;
                        iy += 1;
                    } else {
                        ex -= ey;
                        ey = dx * res;
                        iy += 1;
                    }
                    if outside(ix, iy) || !visit(iy, ix) || (ix == ixb && iy == iyb) {
                        return;
                    }
                }
            } else {
                let mut ey = (p1[1] - iy * res) * dx;
                loop {
                    if ex <= ey {
                        ey -= ex;
                        ex = dy * res;
                        ix += 1;
                    } else {
                        ex -= ey;
                        ey = dx * res;
                        iy -= 1;
                    }
                    if outside(ix, iy) || !visit(iy, ix) || (ix == ixb && iy == iyb) {
                        return;
                    }
                }
            }
        } else {
            let mut ex = (p1[0] - ix * res) * dy;
            if p1[1] < p2[1] {
                let mut ey = ((iy + 1) * res - p1[1]) * dx;
                loop {
                    if ex < ey {
                        ey -= ex;
                        ex = dy * res;
                        ix -= 1;
                    } else {
                        ex -= ey;
                        ey = dx * res;
                        iy += 1;
                    }
                    if outside(ix, iy) || !visit(iy, ix) || (ix == ixb && iy == iyb) {
                        return;
                    }
                }
            } else {
                let mut ey = (p1[1] - iy * res) * dx;
                loop {
                    if ex < ey {
                        ey -= ex;
                        ex = dy * res;
                        ix -= 1;
                    } else if ex == ey {
                        if dx > 0 {
                            ex = dy * res;
                            ix -= 1;
                        }
                        if dy > 0 {
                            ey = dx * res;
                            iy -= 1;
                        }
                    } else {
                        ex -= ey;
                        ey = dx * res;
                        iy -= 1;
                    }
                    if outside(ix, iy) || !visit(iy, ix) || (ix == ixb && iy == iyb) {
                        return;
                    }
                }
            }
        }
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "coordinates of a plate in millionths of a mm"
    )]
    fn crossing_near_end(&self, a: P, b: P, within: f64) -> Option<P> {
        if self.cells.is_empty() {
            return None;
        }
        let (ua, ub) = (to_units(a), to_units(b));
        let inside = |u: [i64; 2]| {
            u[0] >= self.min[0]
                && u[1] >= self.min[1]
                && u[0] < self.min[0] + self.cols * self.res
                && u[1] < self.min[1] + self.rows * self.res
        };
        if !inside(ua) || !inside(ub) {
            return None;
        }
        let (fa, fb) = ([ua[0] as f64, ua[1] as f64], [ub[0] as f64, ub[1] as f64]);
        let mut d2min = f64::MAX;
        let mut found = [0.0_f64; 2];
        let cols = self.cols;
        self.walk(ua, ub, &mut |iy, ix| {
            let Some(cell) = usize::try_from(iy * cols + ix)
                .ok()
                .and_then(|c| self.cells.get(c))
            else {
                return true;
            };
            for &e in cell {
                let Some(&(c, d)) = self.edges.get(e) else {
                    continue;
                };
                let (fc, fd) = ([c[0] as f64, c[1] as f64], [d[0] as f64, d[1] as f64]);
                if let Some(ip) = segment_intersection(fa, fb, fc, fd) {
                    let d2 = (found[0] - fb[0]).m_powi(2) + (found[1] - fb[1]).m_powi(2);
                    if d2 < d2min {
                        d2min = d2;
                        found = ip;
                    }
                }
            }
            true
        });
        let limit = 2.0 * self.res as f64;
        let _ = within;
        (d2min < limit * limit).then(|| [found[0] / UNITS, found[1] / UNITS])
    }
}

fn closest_on_segment(p: P, a: P, b: P) -> P {
    let ab = sub(b, a);
    let l2 = ab[0] * ab[0] + ab[1] * ab[1];
    if l2 <= 0.0 {
        return a;
    }
    let t = (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2).clamp(0.0, 1.0);
    [a[0] + ab[0] * t, a[1] + ab[1] * t]
}

/// The crossing point of two segments, when they cross.
fn segment_intersection(a: P, b: P, c: P, d: P) -> Option<P> {
    let r = sub(b, a);
    let s = sub(d, c);
    let den = r[0] * s[1] - r[1] * s[0];
    if den.abs() < 1e-12 {
        return None;
    }
    let ca = sub(c, a);
    let t = (ca[0] * s[1] - ca[1] * s[0]) / den;
    let u = (ca[0] * r[1] - ca[1] * r[0]) / den;
    ((0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u)).then(|| [a[0] + r[0] * t, a[1] + r[1] * t])
}

impl Forest {
    fn add_root(&mut self, p: P, ground: Option<P>) -> usize {
        self.nodes.push(Node {
            p,
            parent: None,
            children: Vec::new(),
            root: true,
            ground,
        });
        let i = self.nodes.len() - 1;
        self.roots.push(i);
        i
    }

    fn new_node(&mut self, p: P) -> usize {
        self.nodes.push(Node {
            p,
            parent: None,
            children: Vec::new(),
            root: true,
            ground: None,
        });
        self.nodes.len() - 1
    }

    fn node(&self, i: usize) -> Option<&Node> {
        self.nodes.get(i)
    }

    fn add_child(&mut self, parent: usize, child: usize) {
        if let Some(n) = self.nodes.get_mut(parent) {
            n.children.push(child);
        }
        if let Some(c) = self.nodes.get_mut(child) {
            c.parent = Some(parent);
            c.root = false;
        }
    }

    fn add_leaf(&mut self, parent: usize, p: P) -> usize {
        let c = self.new_node(p);
        self.add_child(parent, c);
        c
    }

    fn valence(&self, i: usize) -> usize {
        self.node(i)
            .map_or(0, |n| usize::from(!n.root) + n.children.len())
    }

    fn has_offspring(&self, of: usize, candidate: usize) -> bool {
        if of == candidate {
            return true;
        }
        self.node(of)
            .is_some_and(|n| n.children.iter().any(|&c| self.has_offspring(c, candidate)))
    }

    /// Distance to `loc`, less a bonus for nodes with few branches so trees grow branches where they are.
    fn weighted_distance(&self, i: usize, loc: P, radius: f64) -> f64 {
        let v = self.valence(i);
        let boost = if (1..4).contains(&v) { 4.0 * radius } else { 0.0 };
        self.node(i).map_or(f64::MAX, |n| dist(n.p, loc) - boost)
    }

    fn closest_node(&self, i: usize, loc: P) -> usize {
        let mut best = i;
        let mut best_d = self.node(i).map_or(f64::MAX, |n| dist(n.p, loc));
        for &c in self.node(i).map_or(&[][..], |n| n.children.as_slice()) {
            let cand = self.closest_node(c, loc);
            let d = self.node(cand).map_or(f64::MAX, |n| dist(n.p, loc));
            if d < best_d {
                best_d = d;
                best = cand;
            }
        }
        best
    }

    /// Makes `i` the root of its tree, turning the path to the old root around.
    fn reroot(&mut self, i: usize, new_parent: Option<usize>) {
        let parent = self.node(i).and_then(|n| if n.root { None } else { n.parent });
        if let Some(old) = parent {
            self.reroot(old, Some(i));
            if let Some(n) = self.nodes.get_mut(i) {
                n.children.push(old);
            }
        }
        match new_parent {
            Some(np) => {
                if let Some(n) = self.nodes.get_mut(i) {
                    n.children.retain(|&c| c != np);
                    n.root = false;
                    n.parent = Some(np);
                }
            }
            None => {
                if let Some(n) = self.nodes.get_mut(i) {
                    n.root = true;
                    n.parent = None;
                }
            }
        }
    }

    /// Copies the tree under `i` into `into`, returning the copy's root.
    fn copy_into(&self, i: usize, into: &mut Forest, parent: Option<usize>) -> usize {
        let Some(src) = self.nodes.get(i) else {
            return into.new_node([0.0, 0.0]);
        };
        let c = into.new_node(src.p);
        if let Some(p) = parent {
            into.add_child(p, c);
        } else if let Some(n) = into.nodes.get_mut(c) {
            n.root = src.root;
            n.ground = if src.root {
                Some(src.ground.unwrap_or(src.p))
            } else {
                None
            };
        }
        for &k in &src.children {
            self.copy_into(k, into, Some(c));
        }
        c
    }

    /// Cuts the tree's ends back by `distance` in all.
    fn prune(&mut self, i: usize, distance: f64) -> f64 {
        if distance <= 0.0 {
            return 0.0;
        }
        let kids: Vec<usize> = self.node(i).map_or_else(Vec::new, |n| n.children.clone());
        let here = self.node(i).map_or([0.0, 0.0], |n| n.p);
        let mut max_pruned = 0.0f64;
        let mut keep: Vec<usize> = Vec::new();
        for c in kids {
            let pruned = self.prune(c, distance);
            if pruned >= distance {
                max_pruned = max_pruned.max(pruned);
                keep.push(c);
                continue;
            }
            let b = self.node(c).map_or(here, |n| n.p);
            let ab = dist(here, b);
            if pruned + ab <= distance {
                max_pruned = max_pruned.max(pruned + ab);
            } else {
                // Pruning stops between this node and the child.
                let d = sub(here, b);
                let l = len(d).max(1e-12);
                let k = (distance - pruned) / l;
                if let Some(n) = self.nodes.get_mut(c) {
                    n.p = [b[0] + d[0] * k, b[1] + d[1] * k];
                }
                max_pruned = max_pruned.max(distance);
                keep.push(c);
            }
        }
        if let Some(n) = self.nodes.get_mut(i) {
            n.children = keep;
        }
        max_pruned
    }

    /// Straightens runs of single branches toward the junction above and below them.
    fn straighten(
        &mut self,
        i: usize,
        magnitude: f64,
        above: P,
        accumulated: f64,
        max_colinear: f64,
    ) -> (f64, P) {
        let junction_magnitude = magnitude * 3.0 / 4.0;
        let kids: Vec<usize> = self.node(i).map_or_else(Vec::new, |n| n.children.clone());
        let here = self.node(i).map_or([0.0, 0.0], |n| n.p);
        if let [child] = kids.as_slice() {
            let child_p = self.node(*child).map_or(here, |n| n.p);
            let child_dist = dist(here, child_p);
            let (total, below) =
                self.straighten(*child, magnitude, above, accumulated + child_dist, max_colinear);
            if dist(above, below) > 1e-9 {
                let ab = sub(below, above);
                let t = accumulated / total.max(1.0 / SCALE);
                let dest = [above[0] + ab[0] * t, above[1] + ab[1] * t];
                let move_by = sub(dest, here);
                let np = if len(move_by) <= magnitude {
                    dest
                } else {
                    let l = len(move_by);
                    [
                        here[0] + move_by[0] / l * magnitude,
                        here[1] + move_by[1] / l * magnitude,
                    ]
                };
                if let Some(n) = self.nodes.get_mut(i) {
                    n.p = np;
                }
            }
            // Drop this node when it lies on the line between its parent and its child.
            let child_now = self.node(i).and_then(|n| n.children.first().copied());
            let parent = self.node(i).and_then(|n| n.parent);
            if let (Some(child), Some(parent)) = (child_now, parent) {
                let (cp, pp, me) = (
                    self.node(child).map_or(here, |n| n.p),
                    self.node(parent).map_or(here, |n| n.p),
                    self.node(i).map_or(here, |n| n.p),
                );
                if dist(cp, pp) < max_colinear && dist(me, closest_on_segment(me, pp, cp)) < 1e-5 {
                    if let Some(c) = self.nodes.get_mut(child) {
                        c.parent = Some(parent);
                    }
                    if let Some(pn) = self.nodes.get_mut(parent) {
                        for s in &mut pn.children {
                            if *s == i {
                                *s = child;
                            }
                        }
                    }
                }
            }
            return (total, below);
        }
        // A junction (or a tip): it slides toward the middle of what it joins.
        // Orca's weight is 1000 units of a millionth of a mm, so a junction moves by a few micrometers a layer.
        let weight = 1000.0 / UNITS;
        let to_above = sub(above, here);
        let l = len(to_above).max(1e-12);
        let mut moving = [to_above[0] / l * weight, to_above[1] / l * weight];
        let mut prevent = false;
        for c in &kids {
            let child_dist = dist(here, self.node(*c).map_or(here, |n| n.p));
            let (below_total, below_loc) = self.straighten(*c, magnitude, here, child_dist, max_colinear);
            let d = sub(below_loc, here);
            let dl = len(d).max(1e-12);
            moving[0] += d[0] / dl * weight;
            moving[1] += d[1] / dl * weight;
            if below_total < magnitude {
                prevent = true;
            }
        }
        let is_root = self.node(i).is_none_or(|n| n.root);
        if (moving[0] != 0.0 || moving[1] != 0.0) && !kids.is_empty() && !is_root && !prevent {
            let ml = len(moving);
            let scale = if ml > junction_magnitude {
                junction_magnitude / ml
            } else {
                1.0
            };
            if let Some(n) = self.nodes.get_mut(i) {
                n.p = [n.p[0] + moving[0] * scale, n.p[1] + moving[1] * scale];
            }
        }
        (accumulated, self.node(i).map_or(here, |n| n.p))
    }

    /// Keeps the part of the tree that is still inside `outlines`; the parts cut off become trees of
    /// their own, pushed onto `parts`. False when this node is outside.
    fn realign(&mut self, i: usize, outlines: &Outline, parts: &mut Vec<usize>) -> bool {
        if outlines.is_empty() {
            return false;
        }
        let here = self.node(i).map_or([0.0, 0.0], |n| n.p);
        let kids: Vec<usize> = self.node(i).map_or_else(Vec::new, |n| n.children.clone());
        if outlines.inside(here) {
            let mut keep: Vec<usize> = Vec::new();
            let mut reground = false;
            for c in kids {
                let connected = self.realign(c, outlines, parts);
                let cp = self.node(c).map_or(here, |n| n.p);
                if connected && outlines.crossing_near_end(cp, here, 2.0 * LOCATOR_CELL).is_some() {
                    if let Some(n) = self.nodes.get_mut(c) {
                        n.ground = None;
                        n.parent = None;
                        n.root = true;
                    }
                    parts.push(c);
                    reground = true;
                } else if connected {
                    keep.push(c);
                }
            }
            if let Some(n) = self.nodes.get_mut(i) {
                n.children = keep;
                if reground {
                    n.ground = None;
                }
            }
            return true;
        }
        // Outside: lift any descendants that are inside out of this tree.
        for c in kids {
            if self.realign(c, outlines, parts) {
                if let Some(n) = self.nodes.get_mut(c) {
                    n.ground = Some(here);
                    n.parent = None;
                    n.root = true;
                }
                parts.push(c);
            }
        }
        if let Some(n) = self.nodes.get_mut(i) {
            n.children.clear();
        }
        false
    }

    /// The tree under `i` as polylines from each tip toward the root, each joint shortened by `overlap`.
    fn polylines(&self, i: usize, overlap: f64, out: &mut Vec<Vec<P>>) {
        let start = out.len();
        out.push(Vec::new());
        self.walk(i, start, out);
        let mut k = start;
        while k < out.len() {
            if out.get(k).is_none_or(|l| l.len() <= 1) {
                let last = out.len() - 1;
                out.swap(k, last);
                out.pop();
                continue;
            }
            trim_end(out.get_mut(k), overlap);
            if out.get(k).is_none_or(|l| l.len() <= 1) {
                let last = out.len() - 1;
                out.swap(k, last);
                out.pop();
            } else {
                k += 1;
            }
        }
    }

    fn walk(&self, i: usize, line: usize, out: &mut Vec<Vec<P>>) {
        let Some(n) = self.node(i) else { return };
        let Some(&first) = n.children.first() else {
            if let Some(l) = out.get_mut(line) {
                l.push(n.p);
            }
            return;
        };
        self.walk(first, line, out);
        if let Some(l) = out.get_mut(line) {
            l.push(n.p);
        }
        for &c in n.children.iter().skip(1) {
            out.push(Vec::new());
            let idx = out.len() - 1;
            self.walk(c, idx, out);
            if let Some(l) = out.get_mut(idx) {
                l.push(n.p);
            }
        }
    }
}

/// Shortens the end of a polyline by `by` mm.
fn trim_end(line: Option<&mut Vec<P>>, by: f64) {
    let Some(line) = line else { return };
    let mut left = by;
    while line.len() >= 2 {
        let (Some(&a), Some(&b)) = (line.last(), line.get(line.len() - 2)) else {
            break;
        };
        let l = dist(a, b);
        if l >= left {
            let t = if l > 0.0 { left / l } else { 0.0 };
            if let Some(last) = line.last_mut() {
                *last = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            }
            break;
        }
        left -= l;
        line.pop();
    }
}

/// The points of a layer's overhang that still need a branch near them.
struct DistanceField {
    points: Vec<(P, f64)>,
    erased: Vec<bool>,
    grid: HashMap<(i64, i64), usize>,
    radius: f64,
    cell: f64,
    origin: P,
}

impl DistanceField {
    fn new(radius: f64, overhang: &Shapes, origin: P) -> Self {
        let cell = radius / RADIUS_PER_CELL;
        let mut points: Vec<(P, f64)> = Vec::new();
        let half = crate::geom::mm(cell / 2.0);
        // Dangling slivers are dropped before sampling.
        let cleaned = perimeters::offset(&perimeters::offset(overhang, -half), half);
        let bounds = perimeters::bounds(overhang);
        if let Some(b) = bounds {
            let x_min = f64::from(b[0]) / SCALE;
            for shape in &cleaned {
                let rings = to_mm(&vec![shape.clone()]);
                sample_grid(&rings, cell, x_min, &mut points);
            }
        }
        // Points near the overhang's edge first, spread pseudo-randomly within a radius of each other. Orca's
        // comparison (`std::stable_sort` over distance, with a hash between points less than a radius apart in
        // distance) is not an ordering, so the result depends on the sort: the one of libc++ is followed.
        #[allow(clippy::cast_possible_truncation, reason = "distances in millionths of a mm")]
        let radius_units = (radius * UNITS) as i64;
        libcxx_stable_sort(&mut points, &|a: &(P, f64), b: &(P, f64)| {
            #[allow(clippy::cast_possible_truncation, reason = "distances in millionths of a mm")]
            let (da, db) = ((a.1 * UNITS) as i64, (b.1 * UNITS) as i64);
            if (db - da).abs() > radius_units {
                da < db
            } else {
                hash(a.0) < hash(b.0)
            }
        });
        let erased = vec![false; points.len()];
        let mut grid = HashMap::new();
        for (idx, (p, _)) in points.iter().enumerate() {
            grid.insert(grid_cell(*p, origin, cell), idx);
        }
        Self {
            points,
            erased,
            grid,
            radius,
            cell,
            origin,
        }
    }

    fn erase(&mut self, idx: usize) {
        if let Some(e) = self.erased.get_mut(idx) {
            *e = true;
        }
    }

    fn next(&self, from: usize) -> Option<(usize, P)> {
        (from..self.points.len())
            .find(|&i| !self.erased.get(i).copied().unwrap_or(true))
            .and_then(|i| self.points.get(i).map(|(p, _)| (i, *p)))
    }

    /// Everything within the supporting radius of the new leaf is supported now (Orca's `DistanceField::update`):
    /// the cells of the grid around the leaf are tested at their corner, which has to lie in the circle at the
    /// leaf, or outside the stretch the new branch covers (a corner beside the branch, farther than a circle
    /// away, keeps its point whatever the point's own distance), and the point then has to be in the circle.
    fn update(&mut self, to_node: P, leaf: P) {
        let r = self.radius;
        let v = sub(leaf, to_node);
        let l2 = v[0] * v[0] + v[1] * v[1];
        let l = l2.sqrt().max(1e-12);
        let extent = [-v[1] / l * r, v[0] / l * r];
        let mut lo = [leaf[0] - r, leaf[1] - r];
        let mut hi = [leaf[0] + r, leaf[1] + r];
        for p in [
            [to_node[0] - extent[0], to_node[1] - extent[1]],
            [to_node[0] + extent[0], to_node[1] + extent[1]],
            [leaf[0] - extent[0], leaf[1] - extent[1]],
            [leaf[0] + extent[0], leaf[1] + extent[1]],
        ] {
            lo = [lo[0].min(p[0]), lo[1].min(p[1])];
            hi = [hi[0].max(p[0]), hi[1].max(p[1])];
        }
        // Orca clips the box to that of the outlines, where its points always lie; ours may lie a hair outside.
        let g0 = grid_cell(lo, self.origin, self.cell);
        let g1 = grid_cell(hi, self.origin, self.cell);
        for gy in g0.1..=g1.1 {
            for gx in g0.0..=g1.0 {
                #[allow(clippy::cast_precision_loss, reason = "grid indexes are small")]
                let corner = [
                    gx as f64 * self.cell + self.origin[0],
                    gy as f64 * self.cell + self.origin[1],
                ];
                if dist(corner, leaf) > r {
                    let vx = sub(corner, to_node);
                    let along = v[0] * vx[0] + v[1] * vx[1];
                    if along >= 0.0 && along <= l2 {
                        let across = extent[0] * vx[0] + extent[1] * vx[1];
                        // One millionth of a mm in the units of the line, a thin band along the branch.
                        if across < -1e-6 * UNITS_PER_MM || across > 1e-6 * UNITS_PER_MM {
                            continue;
                        }
                    }
                }
                if let Some(&idx) = self.grid.get(&(gx, gy))
                    && let Some((p, _)) = self.points.get(idx)
                    && dist(*p, leaf) <= r
                    && let Some(e) = self.erased.get_mut(idx)
                {
                    *e = true;
                }
            }
        }
    }
}

fn grid_cell(p: P, origin: P, cell: f64) -> (i64, i64) {
    #[allow(clippy::cast_possible_truncation, reason = "cell indexes are small")]
    (
        ((p[0] - origin[0]) / cell).floor() as i64,
        ((p[1] - origin[1]) / cell).floor() as i64,
    )
}

/// Orca's `PointHash` of a point, modulo the prime the comparison uses.
fn hash(p: P) -> u64 {
    let u = to_units(p);
    let h = (89_i64 * 31 + u[0]).wrapping_mul(31).wrapping_add(u[1]);
    #[allow(
        clippy::cast_sign_loss,
        reason = "Orca converts the signed hash to an unsigned size"
    )]
    {
        (h as u64) % 191
    }
}

/// libc++'s `std::stable_sort` (insertion sort up to 128 elements, else merge sort through a buffer), for a
/// comparison that is not a strict weak order, where the result depends on the algorithm.
fn libcxx_stable_sort<T: Clone>(v: &mut [T], comp: &dyn Fn(&T, &T) -> bool) {
    sort_in_place(v, comp);
}

fn sort_in_place<T: Clone>(v: &mut [T], comp: &dyn Fn(&T, &T) -> bool) {
    let len = v.len();
    match len {
        0 | 1 => return,
        2 => {
            if let [a, b] = v
                && comp(b, a)
            {
                v.swap(0, 1);
            }
            return;
        }
        _ => {}
    }
    if len <= 128 {
        insertion_sort(v, comp);
        return;
    }
    let l2 = len / 2;
    let (left, right) = v.split_at_mut(l2);
    let a = sort_move(left, comp);
    let b = sort_move(right, comp);
    let merged = merge(&a, &b, comp);
    for (slot, x) in v.iter_mut().zip(merged) {
        *slot = x;
    }
}

fn sort_move<T: Clone>(src: &mut [T], comp: &dyn Fn(&T, &T) -> bool) -> Vec<T> {
    let len = src.len();
    match len {
        0 => return Vec::new(),
        1 => return src.to_vec(),
        2 => {
            return match src {
                [a, b] if comp(b, a) => vec![b.clone(), a.clone()],
                _ => src.to_vec(),
            };
        }
        _ => {}
    }
    if len <= 8 {
        return insertion_sort_move(src, comp);
    }
    let l2 = len / 2;
    let (left, right) = src.split_at_mut(l2);
    sort_in_place(left, comp);
    sort_in_place(right, comp);
    merge(left, right, comp)
}

fn merge<T: Clone>(a: &[T], b: &[T], comp: &dyn Fn(&T, &T) -> bool) -> Vec<T> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() {
        let Some(first) = a.get(i) else { break };
        match b.get(j) {
            None => {
                out.extend_from_slice(a.get(i..).unwrap_or(&[]));
                return out;
            }
            Some(second) => {
                if comp(second, first) {
                    out.push(second.clone());
                    j += 1;
                } else {
                    out.push(first.clone());
                    i += 1;
                }
            }
        }
    }
    out.extend_from_slice(b.get(j..).unwrap_or(&[]));
    out
}

fn insertion_sort<T: Clone>(v: &mut [T], comp: &dyn Fn(&T, &T) -> bool) {
    for i in 1..v.len() {
        let (Some(cur), Some(prev)) = (v.get(i), v.get(i - 1)) else {
            continue;
        };
        if !comp(cur, prev) {
            continue;
        }
        let t = cur.clone();
        let (mut j, mut k) = (i, i - 1);
        loop {
            let moved = v.get(k).cloned();
            if let (Some(m), Some(slot)) = (moved, v.get_mut(j)) {
                *slot = m;
            }
            j = k;
            if j == 0 {
                break;
            }
            k -= 1;
            if !v.get(k).is_some_and(|x| comp(&t, x)) {
                break;
            }
        }
        if let Some(slot) = v.get_mut(j) {
            *slot = t;
        }
    }
}

fn insertion_sort_move<T: Clone>(src: &[T], comp: &dyn Fn(&T, &T) -> bool) -> Vec<T> {
    let mut out: Vec<T> = Vec::with_capacity(src.len());
    for x in src {
        let Some(last) = out.last().cloned() else {
            out.push(x.clone());
            continue;
        };
        if comp(x, &last) {
            out.push(last);
            let n = out.len();
            let (mut j2, mut i2) = (n - 2, n - 2);
            while i2 != 0 {
                i2 -= 1;
                if out.get(i2).is_some_and(|y| comp(x, y)) {
                    let moved = out.get(i2).cloned();
                    if let (Some(m), Some(slot)) = (moved, out.get_mut(j2)) {
                        *slot = m;
                    }
                    j2 -= 1;
                } else {
                    break;
                }
            }
            if let Some(slot) = out.get_mut(j2) {
                *slot = x.clone();
            }
        } else {
            out.push(x.clone());
        }
    }
    out
}

/// Grid points inside one shape (its rings): vertical lines `cell` apart from `x_min`, points on each
/// at multiples of `cell` between the crossings. Each comes with its distance to the shape's boundary.
fn sample_grid(rings: &[Vec<P>], cell: f64, x_min: f64, out: &mut Vec<(P, f64)>) {
    let Some((mut lo, mut hi)) = rings.iter().flatten().fold(None, |acc: Option<(P, P)>, p| {
        Some(match acc {
            None => (*p, *p),
            Some((l, h)) => ([l[0].min(p[0]), l[1].min(p[1])], [h[0].max(p[0]), h[1].max(p[1])]),
        })
    }) else {
        return;
    };
    lo[0] -= cell;
    hi[0] += cell;
    #[allow(clippy::cast_possible_truncation, reason = "line indexes are small")]
    let (k0, k1) = (
        ((lo[0] - x_min) / cell).floor() as i64,
        ((hi[0] - x_min) / cell).ceil() as i64,
    );
    for k in k0..=k1 {
        #[allow(clippy::cast_precision_loss, reason = "line indexes are small")]
        let x = x_min + k as f64 * cell;
        let mut ys: Vec<f64> = Vec::new();
        for ring in rings {
            let n = ring.len();
            for j in 0..n {
                let (Some(&a), Some(&b)) = (ring.get(j), ring.get((j + 1) % n)) else {
                    continue;
                };
                if (a[0] > x) != (b[0] > x) {
                    ys.push(a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]));
                }
            }
        }
        ys.sort_by(f64::total_cmp);
        for pair in ys.chunks(2) {
            let [a, b] = pair else { continue };
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_precision_loss,
                reason = "indexes are small"
            )]
            let first = (a / cell).floor() as i64;
            let mut m = first;
            loop {
                #[allow(clippy::cast_precision_loss, reason = "indexes are small")]
                let y = m as f64 * cell;
                if y >= *b {
                    break;
                }
                if y > *a {
                    let p = [x, y];
                    out.push((p, boundary_distance(rings, p)));
                }
                m += 1;
            }
        }
    }
}

fn boundary_distance(rings: &[Vec<P>], p: P) -> f64 {
    let mut best = f64::MAX;
    for ring in rings {
        let n = ring.len();
        for k in 0..n {
            if let (Some(&a), Some(&b)) = (ring.get(k), ring.get((k + 1) % n)) {
                best = best.min(dist(p, closest_on_segment(p, a, b)));
            }
        }
    }
    best
}

/// Where a new leaf attaches: to a node of a tree, or to the closest point of the outline.
enum Grounding {
    Node(usize),
    Boundary(P),
}

struct Context<'a> {
    outline: &'a Outline,
    nodes_at: HashMap<(i64, i64), Vec<usize>>,
    supporting_radius: f64,
    /// Corner of the box of the layer's outlines, where the grid of nodes starts (`to_grid_point`).
    origin: P,
}

impl Context<'_> {
    fn register(&mut self, forest: &Forest, i: usize) {
        if let Some(n) = forest.node(i) {
            self.nodes_at
                .entry(grid_cell(n.p, self.origin, LOCATOR_CELL))
                .or_default()
                .push(i);
        }
    }

    fn best_grounding(
        &self,
        forest: &Forest,
        loc: P,
        min_dist_for_tree: f64,
        exclude: Option<usize>,
    ) -> Grounding {
        let node_loc = self.outline.closest(loc).unwrap_or(loc);
        let within = dist(node_loc, loc);
        let mut best: Option<usize> = None;
        let mut current = within;
        if current >= min_dist_for_tree {
            let search = current.min(within);
            let lo = grid_cell([loc[0] - search, loc[1] - search], self.origin, LOCATOR_CELL);
            let hi = grid_cell(
                [loc[0] + search + LOCATOR_CELL, loc[1] + search + LOCATOR_CELL],
                self.origin,
                LOCATOR_CELL,
            );
            for cy in lo.1..=hi.1 {
                for cx in lo.0..=hi.0 {
                    for &cand in self.nodes_at.get(&(cx, cy)).map_or(&[][..], Vec::as_slice) {
                        if Some(cand) == exclude {
                            continue;
                        }
                        if exclude.is_some_and(|e| forest.has_offspring(e, cand)) {
                            continue;
                        }
                        let Some(n) = forest.node(cand) else { continue };
                        // Only a node that would be taken is tested against the outline (the same result as
                        // testing every one, much less work).
                        let d = forest.weighted_distance(cand, loc, self.supporting_radius);
                        if d < current && !self.outline.collides(loc, n.p) {
                            current = d;
                            best = Some(cand);
                        }
                    }
                }
            }
        }
        match best {
            Some(n) => Grounding::Node(n),
            None => Grounding::Boundary(node_loc),
        }
    }
}

/// The lines of every layer, from the sparse areas of the layers (`areas[0]` the bottom one).
pub(crate) fn plan(areas: &[Shapes], p: &Params) -> Vec<Vec<Vec<P>>> {
    plan_with(areas, None, p)
}

/// [`plan`] with the areas to hold up on each layer given (Orca's `Generator` for supports, which takes the
/// overhangs from the tree support) instead of found from the areas.
pub(crate) fn plan_with(areas: &[Shapes], given: Option<Vec<Shapes>>, p: &Params) -> Vec<Vec<Vec<P>>> {
    let n = areas.len();
    let supporting_radius = p.line_width * 100.0 / p.density_percent.max(1.0);
    let wall_radius = p.layer_height * p.overhang_angle.to_radians().m_tan();
    let prune_len = p.layer_height * p.prune_angle.to_radians().m_tan();
    let straighten_max = p.layer_height * p.straighten_angle.to_radians().m_tan();
    // What each layer's sparse area needs held up: beyond the wall's reach and not under the layer above.
    let overhangs = given.unwrap_or_else(|| {
        let mut overhangs: Vec<Shapes> = vec![Vec::new(); n];
        let mut above: Shapes = Vec::new();
        for l in (0..n).rev() {
            let here = areas.get(l).cloned().unwrap_or_default();
            let shrunk = perimeters::offset(&here, -crate::geom::mm(wall_radius));
            if let Some(o) = overhangs.get_mut(l) {
                *o = perimeters::difference(&shrunk, &above);
            }
            above = here;
        }
        overhangs
    });
    let mut forests: Vec<Forest> = vec![Forest::default(); n];
    let mut lines: Vec<Vec<Vec<P>>> = vec![Vec::new(); n];
    // The edge grid of the layer in hand, built while the layer above was finished: its box is the box of every
    // outline so far and of the trees (Orca's `outlines_locator`).
    let mut pending: Option<Outline> = None;
    #[allow(
        clippy::cast_possible_truncation,
        reason = "units per internal unit is a whole number"
    )]
    let top_seed = n.checked_sub(1).and_then(|t| areas.get(t)).and_then(|a| {
        perimeters::bounds(a).map(|b| {
            let e = 100;
            let k = (UNITS / SCALE) as i64;
            [
                i64::from(b[0]) * k - e,
                i64::from(b[1]) * k - e,
                i64::from(b[2]) * k + e,
                i64::from(b[3]) * k + e,
            ]
        })
    });
    for l in (0..n).rev() {
        let outlines = areas.get(l).cloned().unwrap_or_default();
        let outline = pending
            .take()
            .unwrap_or_else(|| Outline::new(&outlines, top_seed));
        let origin = perimeters::bounds(&outlines)
            .map_or([0.0, 0.0], |b| [f64::from(b[0]) / SCALE, f64::from(b[1]) / SCALE]);
        let overhang = overhangs.get(l).cloned().unwrap_or_default();
        let mut forest = forests.get_mut(l).map(std::mem::take).unwrap_or_default();
        let carried: Vec<usize> = forest.roots.clone();
        let mut ctx = Context {
            outline: &outline,
            nodes_at: HashMap::new(),
            supporting_radius,
            origin,
        };
        for i in 0..forest.nodes.len() {
            ctx.register(&forest, i);
        }
        // New branches for what nothing holds up yet.
        if !overhang.is_empty() && !outline.is_empty() {
            let mut field = DistanceField::new(supporting_radius, &overhang, origin);
            let mut from = 0usize;
            while let Some((idx, loc)) = field.next(from) {
                from = idx;
                let ground = ctx.best_grounding(&forest, loc, wall_radius, None);
                let (leaf, anchor) = match ground {
                    Grounding::Boundary(b) => {
                        let root = forest.add_root(b, Some(b));
                        let leaf = forest.add_leaf(root, loc);
                        ctx.register(&forest, root);
                        (leaf, b)
                    }
                    Grounding::Node(node) => {
                        let at = forest.node(node).map_or(loc, |x| x.p);
                        (forest.add_leaf(node, loc), at)
                    }
                };
                ctx.register(&forest, leaf);
                field.update(anchor, loc);
                // The point that made the leaf is supported by it, whatever the grid says.
                field.erase(idx);
            }
        }
        // Trees carried down from above reconnect to the outline or to a neighbor.
        reconnect(&mut forest, &carried, &mut ctx, wall_radius);
        // Lines of this layer.
        let overlap = p.joint_overlap;
        let roots = forest.roots.clone();
        let mut out: Vec<Vec<P>> = Vec::new();
        for r in roots {
            forest.polylines(r, overlap, &mut out);
        }
        if let Some(slot) = lines.get_mut(l) {
            *slot = out;
        }
        if l == 0 {
            break;
        }
        // Down to the layer below: prune, straighten, realign.
        let below_outlines = areas.get(l - 1).cloned().unwrap_or_default();
        // The next grid's box: its own outlines, the grid so far and every node of the trees.
        let seed = {
            let mut b: Option<[i64; 4]> = outline.grid.bbox;
            let mut grow = |u: [i64; 2], e: i64| {
                b = Some(match b {
                    None => [u[0] - e, u[1] - e, u[0] + e, u[1] + e],
                    Some(x) => [
                        x[0].min(u[0] - e),
                        x[1].min(u[1] - e),
                        x[2].max(u[0] + e),
                        x[3].max(u[1] + e),
                    ],
                });
            };
            for ring in to_mm(&below_outlines) {
                for p in ring {
                    grow(to_units(p), 100);
                }
            }
            for node in &forest.nodes {
                grow(to_units(node.p), 100);
            }
            b
        };
        let below = Outline::new(&below_outlines, seed);
        let mut next = Forest::default();
        let mut parts: Vec<usize> = Vec::new();
        for &r in &forest.roots {
            let copy = forest.copy_into(r, &mut next, None);
            next.prune(copy, prune_len);
            next.straighten(
                copy,
                straighten_max,
                next.node(copy).map_or([0.0; 2], |x| x.p),
                0.0,
                LOCATOR_CELL / 2.0,
            );
            if next.realign(copy, &below, &mut parts) {
                parts.push(copy);
            }
        }
        next.roots = parts;
        pending = Some(below);
        if let Some(slot) = forests.get_mut(l - 1) {
            *slot = next;
        }
    }
    lines
}

fn reconnect(forest: &mut Forest, carried: &[usize], ctx: &mut Context<'_>, wall_radius: f64) {
    // Orca takes off 100 units of a millionth of a mm.
    let ignore_width = wall_radius - 0.0001;
    let within = 2.0 * LOCATOR_CELL;
    for &root in carried {
        let Some(node) = forest.node(root).cloned() else {
            continue;
        };
        let Some(pos) = forest.roots.iter().position(|&r| r == root) else {
            continue;
        };
        if let Some(ground) = node.ground
            && dist(ground, node.p) > 1e-9
            && let Some(q) = ctx.outline.crossing_near_end(node.p, ground, within)
        {
            let new_root = forest.new_node(q);
            if let Some(n) = forest.nodes.get_mut(new_root) {
                n.ground = Some(q);
            }
            forest.add_child(root, new_root);
            forest.reroot(new_root, None);
            ctx.register(forest, new_root);
            if let Some(slot) = forest.roots.get_mut(pos) {
                *slot = new_root;
            }
            continue;
        }
        match ctx.best_grounding(forest, node.p, ignore_width, Some(root)) {
            Grounding::Boundary(b) => {
                if dist(b, node.p) < 1e-9 {
                    continue;
                }
                let new_root = forest.new_node(b);
                if let Some(n) = forest.nodes.get_mut(new_root) {
                    n.ground = Some(b);
                }
                let attach = forest.closest_node(root, b);
                forest.reroot(attach, None);
                forest.add_child(new_root, attach);
                ctx.register(forest, new_root);
                if let Some(slot) = forest.roots.get_mut(pos) {
                    *slot = new_root;
                }
            }
            Grounding::Node(target) => {
                let loc = forest.node(target).map_or(node.p, |x| x.p);
                let attach = forest.closest_node(root, loc);
                forest.reroot(attach, None);
                forest.add_child(target, attach);
                forest.roots.swap_remove(pos);
            }
        }
    }
}

/// Clips polylines (mm) to shapes: the pieces that lie inside, in internal units.
pub(crate) fn clip(lines: &[Vec<P>], region: &Shapes) -> Vec<Vec<crate::geom::Point>> {
    let outline = Outline::new(region, None);
    let mut out: Vec<Vec<crate::geom::Point>> = Vec::new();
    let pt = |p: P| crate::geom::Point::from_mm(p[0], p[1]);
    for line in lines {
        let mut current: Vec<P> = Vec::new();
        for w in line.windows(2) {
            let [a, b] = w else { continue };
            // Cut the segment where it crosses the region's edges.
            let mut ts: Vec<f64> = vec![0.0, 1.0];
            for e in outline.near_segment(*a, *b) {
                if let Some(&(c, d)) = outline.edges.get(e)
                    && let Some(q) = segment_intersection(*a, *b, c, d)
                {
                    let l = dist(*a, *b).max(1e-12);
                    ts.push(dist(*a, q) / l);
                }
            }
            ts.sort_by(f64::total_cmp);
            for k in 0..ts.len().saturating_sub(1) {
                let (Some(&t0), Some(&t1)) = (ts.get(k), ts.get(k + 1)) else {
                    continue;
                };
                if t1 - t0 < 1e-9 {
                    continue;
                }
                let at = |t: f64| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                let mid = at(f64::midpoint(t0, t1));
                if outline.inside(mid) {
                    if current.last().is_none_or(|l| dist(*l, at(t0)) > 1e-6) {
                        if current.len() >= 2 {
                            out.push(current.iter().map(|p| pt(*p)).collect());
                        }
                        current = vec![at(t0)];
                    }
                    current.push(at(t1));
                } else if current.len() >= 2 {
                    out.push(current.iter().map(|p| pt(*p)).collect());
                    current.clear();
                } else {
                    current.clear();
                }
            }
        }
        if current.len() >= 2 {
            out.push(current.iter().map(|p| pt(*p)).collect());
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    fn square(x0: f64, y0: f64, side: f64) -> Shapes {
        let p = |x: f64, y: f64| IntPoint::new(crate::geom::mm(x), crate::geom::mm(y));
        vec![vec![vec![
            p(x0, y0),
            p(x0 + side, y0),
            p(x0 + side, y0 + side),
            p(x0, y0 + side),
        ]]]
    }

    fn params() -> Params {
        Params {
            line_width: 0.42,
            joint_overlap: 0.21,
            density_percent: 15.0,
            layer_height: 0.2,
            overhang_angle: 45.0,
            prune_angle: 45.0,
            straighten_angle: 45.0,
        }
    }

    #[test]
    fn a_stack_of_squares_gets_branches_that_reach_the_walls() {
        // Sixty layers of a 30 mm square: the top layer has to be held up everywhere, the layers below keep
        // what the pruning leaves.
        let areas: Vec<Shapes> = (0..60).map(|_| square(10.0, 10.0, 30.0)).collect();
        let lines = plan(&areas, &params());
        assert_eq!(lines.len(), 60);
        let top: f64 = lines[59]
            .iter()
            .flat_map(|l| l.windows(2))
            .map(|w| dist(w[0], w[1]))
            .sum();
        assert!(top > 100.0, "{top} mm on the top layer");
        // Every line stays within a hair of the square.
        for l in lines.iter().flatten().flatten() {
            assert!(l[0] > 9.9 && l[0] < 40.1 && l[1] > 9.9 && l[1] < 40.1, "{l:?}");
        }
    }

    #[test]
    fn points_a_hair_outside_the_outline_box_are_still_supported() {
        // The overhang can reach a hair beyond the outline's box; the field must still mark its points
        // supported (a point left unsupported would be picked again and again).
        let overhang = square(9.95, 9.95, 30.1);
        let mut field = DistanceField::new(2.8, &overhang, [10.0, 10.0]);
        let mut rounds = 0;
        while let Some((idx, loc)) = field.next(0) {
            field.update([10.0, 10.0], loc);
            field.erase(idx);
            rounds += 1;
            assert!(rounds < 10_000, "the field never empties");
        }
        assert!(rounds > 0);
    }

    #[test]
    fn the_stable_sort_keeps_equal_elements_in_order_and_sorts_by_key() {
        let mut v: Vec<(u32, u32)> = (0..500).map(|i| ((i * 7919) % 50, i)).collect();
        libcxx_stable_sort(&mut v, &|a, b| a.0 < b.0);
        assert!(
            v.windows(2)
                .all(|w| w[0].0 < w[1].0 || (w[0].0 == w[1].0 && w[0].1 < w[1].1))
        );
    }

    #[test]
    fn a_line_walk_visits_the_cells_it_passes_in_order() {
        let ring = vec![vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]]];
        let g = EdgeGrid::new(&ring, None);
        let mut cells: Vec<(i64, i64)> = Vec::new();
        let (a, b) = (to_units([1.0, 1.0]), to_units([13.0, 1.0]));
        g.walk(a, b, &mut |iy, ix| {
            cells.push((iy, ix));
            true
        });
        // A horizontal line crosses four 4 mm columns in one row.
        assert_eq!(cells.len(), 4, "{cells:?}");
        assert!(cells.windows(2).all(|w| w[0].0 == w[1].0 && w[1].1 == w[0].1 + 1));
    }
}
