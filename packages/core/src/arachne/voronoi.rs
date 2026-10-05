// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The segment Voronoi diagram of an outline and its transfer into the skeletal graph.
//!
//! Every polygon edge is a site. A segment's cell and the cells of its end points are bounded by
//! finite edges only on the inner side of a closed outline that runs counter-clockwise (holes
//! clockwise), so each cell walks from one end of its segment to the other; the walk becomes a
//! quad in the graph. Curved edges (a point against a segment) and straight edges between two points
//! are cut into short pieces, because the width along them does not change linearly.

#![allow(
    clippy::indexing_slicing,
    reason = "nodes and edges are vector indices that the graph keeps valid"
)]

use super::graph::{EdgeKind, Graph, P, closest_on_line, dist};
use crate::fm::Fm as _;
use boostvoronoi::prelude::{Builder, CellIndex, Diagram, EdgeIndex, SourceCategory, VertexIndex};

/// An outline edge with its neighbors in its ring.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Seg {
    pub(crate) from: P,
    pub(crate) to: P,
    pub(crate) prev: usize,
    pub(crate) next: usize,
}

/// Turns rings (outer counter-clockwise, holes clockwise) into sites.
pub(crate) fn segments_of(rings: &[Vec<P>]) -> Vec<Seg> {
    let mut segs = Vec::new();
    for ring in rings {
        let n = ring.len();
        let base = segs.len();
        for i in 0..n {
            let (Some(a), Some(b)) = (ring.get(i), ring.get((i + 1) % n)) else {
                continue;
            };
            segs.push(Seg {
                from: *a,
                to: *b,
                prev: base + (i + n - 1) % n,
                next: base + (i + 1) % n,
            });
        }
    }
    segs
}

pub(crate) struct Params {
    pub(crate) transitioning_angle: f64,
    pub(crate) discretization_step: i64,
    /// Keep the diagram for a later build of the same outline (see [`diagram`]).
    pub(crate) keep: bool,
}

fn to_p(d: &Diagram, v: VertexIndex) -> Option<P> {
    let v = d.vertex(v).ok()?;
    let (x, y) = (v.x(), v.y());
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, reason = "a Voronoi vertex rounded to nm")]
    Some(P::new(x.round() as i64, y.round() as i64))
}

struct Ctx<'a> {
    d: &'a Diagram,
    segs: &'a [Seg],
    prm: &'a Params,
    g: Graph,
    /// Per Voronoi edge, the last graph edge it became ([`NONE`] for none yet).
    edge_map: Vec<usize>,
    /// Per Voronoi vertex, its graph node ([`NONE`] for none yet).
    node_map: Vec<usize>,
}

struct Range {
    start_src: P,
    end_src: P,
    begin: Option<EdgeIndex>,
    end: Option<EdgeIndex>,
}

/// Diagrams kept per thread for [`diagram`].
#[cfg(not(target_arch = "wasm32"))]
const KEPT_DIAGRAMS: usize = 8;

/// The Voronoi diagram of the segments `input`. A diagram depends on its segments alone, and the island
/// walls of a layer with one-wall top surfaces build the same outline twice (with one wall and with all of
/// them, often for a neighbor layer first), so with `keep` each thread keeps its last diagrams and gives a
/// kept one back for the same segments.
#[cfg(not(target_arch = "wasm32"))]
fn diagram(input: Vec<[i32; 4]>, keep: bool) -> Option<std::rc::Rc<Diagram>> {
    type Kept = std::collections::VecDeque<(u64, Vec<[i32; 4]>, std::rc::Rc<Diagram>)>;
    thread_local! {
        static KEPT: std::cell::RefCell<Kept> = const { std::cell::RefCell::new(std::collections::VecDeque::new()) };
    }
    if !keep {
        let d = Builder::<i32>::default()
            .with_segments(input.iter())
            .ok()?
            .build()
            .ok()?;
        return Some(std::rc::Rc::new(d));
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for v in input.iter().flatten() {
        h = (h ^ u64::from(v.cast_unsigned())).wrapping_mul(0x0000_0100_0000_01b3);
    }
    let found = KEPT.with(|k| {
        k.borrow()
            .iter()
            .find(|(kh, ki, _)| *kh == h && *ki == input)
            .map(|(_, _, d)| std::rc::Rc::clone(d))
    });
    if found.is_some() {
        return found;
    }
    let d = std::rc::Rc::new(
        Builder::<i32>::default()
            .with_segments(input.iter())
            .ok()?
            .build()
            .ok()?,
    );
    KEPT.with(|k| {
        let mut k = k.borrow_mut();
        if k.len() >= KEPT_DIAGRAMS {
            let _ = k.pop_front();
        }
        k.push_back((h, input, std::rc::Rc::clone(&d)));
    });
    Some(d)
}

/// The Voronoi diagram of the segments `input` (the engine WASM keeps none).
#[cfg(target_arch = "wasm32")]
#[allow(
    clippy::needless_pass_by_value,
    reason = "the same signature as the native memo"
)]
fn diagram(input: Vec<[i32; 4]>, _keep: bool) -> Option<Diagram> {
    Builder::<i32>::default()
        .with_segments(input.iter())
        .ok()?
        .build()
        .ok()
}

/// Builds the graph for the outline. Returns `None` when the diagram cannot be built.
pub(crate) fn build(rings: &[Vec<P>], prm: &Params) -> Option<Graph> {
    let segs = segments_of(rings);
    if segs.len() < 3 {
        return None;
    }
    let input: Vec<[i32; 4]> = segs
        .iter()
        .filter_map(|s| {
            Some([
                i32::try_from(s.from.x).ok()?,
                i32::try_from(s.from.y).ok()?,
                i32::try_from(s.to.x).ok()?,
                i32::try_from(s.to.y).ok()?,
            ])
        })
        .collect();
    if input.len() != segs.len() {
        return None;
    }
    let d = diagram(input, prm.keep)?;
    let mut cx = Ctx {
        d: &d,
        segs: &segs,
        prm,
        g: Graph::reused(),
        edge_map: vec![NONE; d.edges().len()],
        node_map: vec![NONE; d.vertices().len()],
    };
    for cell in d.cells() {
        let Some(inc) = cell.get_incident_edge() else {
            continue;
        };
        let range = if cell.contains_point() {
            match cx.point_cell_range(cell.id(), inc) {
                Some(r) => r,
                None => continue,
            }
        } else {
            cx.segment_cell_range(cell.id(), inc)
        };
        let (Some(begin), Some(end)) = (range.begin, range.end) else {
            continue;
        };
        cx.transfer_cell(&range, begin, end);
    }
    let mut g = cx.g;
    separate_pointy_quad_end_nodes(&mut g);
    g.collapse_small_edges(5);
    for e in g.live_edges() {
        if g.edges[e].prev.is_none() {
            let from = g.edges[e].from;
            g.nodes[from].incident_edge = Some(e);
        }
    }
    Some(g)
}

/// No graph edge or node yet, in [`Ctx`]'s maps.
const NONE: usize = usize::MAX;

impl Ctx<'_> {
    fn node_at(&self, v: VertexIndex) -> Option<usize> {
        self.node_map.get(v.usize()).copied().filter(|&n| n != NONE)
    }

    fn edge_at(&self, e: EdgeIndex) -> Option<usize> {
        self.edge_map.get(e.usize()).copied().filter(|&n| n != NONE)
    }

    fn vertex_p(&self, v: Option<VertexIndex>) -> Option<P> {
        to_p(self.d, v?)
    }

    fn source_point(&self, cell: CellIndex) -> Option<P> {
        let c = self.d.cell(cell).ok()?;
        let s = self.segs.get(c.source_index().usize())?;
        match c.source_category() {
            SourceCategory::SegmentStart => Some(s.from),
            SourceCategory::SegmentEnd => Some(s.to),
            _ => None,
        }
    }

    fn source_segment(&self, cell: CellIndex) -> Option<Seg> {
        let c = self.d.cell(cell).ok()?;
        self.segs.get(c.source_index().usize()).copied()
    }

    /// The walk around a segment's cell: from the edge leaving the segment's end point to the edge
    /// arriving at its start point.
    fn segment_cell_range(&self, cell: CellIndex, inc: EdgeIndex) -> Range {
        let seg = self.source_segment(cell);
        let (from, to) = seg.map_or((P::default(), P::default()), |s| (s.from, s.to));
        let mut r = Range {
            start_src: to,
            end_src: from,
            begin: None,
            end: None,
        };
        let mut seen_possible_start = false;
        let mut after_start = false;
        let mut ending_set_before_start = false;
        let mut e = inc;
        let mut guard = 0;
        loop {
            if self.d.edge_is_finite(e).unwrap_or(false) {
                let v0 = self.d.edge(e).ok().and_then(|x| self.vertex_p(x.vertex0()));
                let v1 = self.d.edge_get_vertex1(e).ok().and_then(|v| self.vertex_p(v));
                if let (Some(v0), Some(v1)) = (v0, v1) {
                    if v0 == to && !after_start {
                        r.begin = Some(e);
                        seen_possible_start = true;
                    } else if seen_possible_start {
                        after_start = true;
                    }
                    if v1 == from && (r.end.is_none() || ending_set_before_start) {
                        ending_set_before_start = !after_start;
                        r.end = Some(e);
                    }
                }
            }
            e = match self.d.edge_get_next(e) {
                Ok(n) => n,
                Err(_) => break,
            };
            guard += 1;
            if e == inc || guard > 1_000_000 {
                break;
            }
        }
        r
    }

    /// The walk around a corner's cell, when the cell lies inside the outline.
    fn point_cell_range(&self, cell: CellIndex, inc: EdgeIndex) -> Option<Range> {
        let src = self.source_point(cell)?;
        let mut r = Range {
            start_src: src,
            end_src: src,
            begin: None,
            end: None,
        };
        if !self.d.edge_is_finite(inc).unwrap_or(false) {
            return None;
        }
        let ed = self.d.edge(inc).ok()?;
        let v0 = self.vertex_p(ed.vertex0())?;
        let v1 = self.d.edge_get_vertex1(inc).ok().and_then(|v| self.vertex_p(v))?;
        let query = if v0 == src { v1 } else { v0 };
        let c = self.d.cell(cell).ok()?;
        let s = self.segs.get(c.source_index().usize())?;
        let (prev, next) = match c.source_category() {
            SourceCategory::SegmentStart => (self.segs.get(s.prev)?.from, s.to),
            _ => (s.from, self.segs.get(s.next)?.to),
        };
        if !inside_corner(prev, src, next, query) {
            return None;
        }
        let mut e = inc;
        let mut guard = 0;
        loop {
            let v1 = self.d.edge_get_vertex1(e).ok().and_then(|v| self.vertex_p(v));
            if v1 == Some(src) {
                r.begin = self.d.edge_get_next(e).ok();
                r.end = Some(e);
            }
            e = self.d.edge_get_next(e).ok()?;
            guard += 1;
            if e == inc || guard > 1_000_000 {
                break;
            }
        }
        if r.begin.is_some() && r.end.is_some() && r.begin != r.end {
            Some(r)
        } else {
            None
        }
    }

    /// Walks a cell's edges into the graph as a chain closed by ribs.
    fn transfer_cell(&mut self, r: &Range, begin: EdgeIndex, end: EdgeIndex) -> bool {
        let mut prev_edge: Option<usize> = None;
        let Some(first_v1) = self.d.edge_get_vertex1(begin).ok().and_then(|v| self.vertex_p(v)) else {
            return false;
        };
        self.transfer_edge(r.start_src, first_v1, begin, &mut prev_edge, r);
        let begin_v0 = self
            .d
            .edge(begin)
            .ok()
            .and_then(boostvoronoi::prelude::Edge::vertex0);
        let Some(starting_node) = begin_v0.and_then(|v| self.node_at(v)) else {
            return false;
        };
        self.g.nodes[starting_node].dist = 0;
        let Some(mut pe) = prev_edge else { return false };
        self.g.make_rib(&mut pe, r.start_src, r.end_src);
        prev_edge = Some(pe);
        let Ok(mut e) = self.d.edge_get_next(begin) else {
            return false;
        };
        let mut guard = 0;
        while e != end {
            let v1 = self.d.edge(e).ok().and_then(|x| self.vertex_p(x.vertex0()));
            let v2 = self.d.edge_get_vertex1(e).ok().and_then(|v| self.vertex_p(v));
            let (Some(a), Some(b)) = (v1, v2) else {
                return false;
            };
            self.transfer_edge(a, b, e, &mut prev_edge, r);
            if let Some(mut pe) = prev_edge {
                self.g.make_rib(&mut pe, r.start_src, r.end_src);
                prev_edge = Some(pe);
            }
            e = match self.d.edge_get_next(e) {
                Ok(n) => n,
                Err(_) => return false,
            };
            guard += 1;
            if guard > 1_000_000 {
                return false;
            }
        }
        let end_v0 = self.d.edge(end).ok().and_then(|x| self.vertex_p(x.vertex0()));
        let Some(end_v0) = end_v0 else { return false };
        self.transfer_edge(end_v0, r.end_src, end, &mut prev_edge, r);
        if let Some(pe) = prev_edge {
            let to = self.g.edges[pe].to;
            self.g.nodes[to].dist = 0;
        }
        true
    }

    fn make_node(&mut self, v: VertexIndex, p: P) -> usize {
        if let Some(n) = self.node_at(v) {
            return n;
        }
        let n = self.g.new_node(p, true);
        if let Some(slot) = self.node_map.get_mut(v.usize()) {
            *slot = n;
        }
        n
    }

    fn transfer_edge(
        &mut self,
        from: P,
        to: P,
        vd_edge: EdgeIndex,
        prev_edge: &mut Option<usize>,
        r: &Range,
    ) {
        let twin = self.d.edge_get_twin(vd_edge).ok();
        let twin_he = twin.and_then(|t| self.edge_at(t));
        let v1 = self.d.edge_get_vertex1(vd_edge).ok().flatten();
        if let Some(source_twin) = twin_he {
            // The other side was transferred already: make the twins of its pieces, in reverse.
            let Some(end_node) = v1.and_then(|v| self.node_at(v)) else {
                return;
            };
            let mut twin_e = source_twin;
            let mut guard = 0;
            loop {
                let edge = self.g.new_edge(EdgeKind::Normal, true);
                let (tfrom, tto) = (self.g.edges[twin_e].from, self.g.edges[twin_e].to);
                self.g.edges[edge].from = tto;
                self.g.edges[edge].to = tfrom;
                self.g.edges[edge].twin = Some(twin_e);
                self.g.edges[twin_e].twin = Some(edge);
                let from_node = self.g.edges[edge].from;
                self.g.nodes[from_node].incident_edge = Some(edge);
                if let Some(p) = *prev_edge {
                    self.g.edges[edge].prev = Some(p);
                    self.g.edges[p].next = Some(edge);
                }
                *prev_edge = Some(edge);
                if self.g.edges[edge].to == end_node {
                    return;
                }
                let Some(tp) = self.g.edges[twin_e].prev else {
                    return;
                };
                let Some(tptw) = self.g.edges[tp].twin else { return };
                let Some(next_twin) = self.g.edges[tptw].prev else {
                    return;
                };
                let mut pe = edge;
                self.g.make_rib(&mut pe, r.start_src, r.end_src);
                *prev_edge = Some(pe);
                twin_e = next_twin;
                guard += 1;
                if guard > 100_000 {
                    return;
                }
            }
        }
        let points = self.discretize(vd_edge);
        if points.len() < 2 {
            return;
        }
        let v0_vertex = self
            .d
            .edge(vd_edge)
            .ok()
            .and_then(boostvoronoi::prelude::Edge::vertex0);
        let mut v0 = match *prev_edge {
            Some(p) => self.g.edges[p].to,
            None => match v0_vertex {
                Some(v) => self.make_node(v, from),
                None => return,
            },
        };
        let last = points.len() - 1;
        for (i, p1) in points.iter().enumerate().skip(1) {
            let v1n = if i < last {
                self.g.new_node(*p1, true)
            } else {
                match v1 {
                    Some(v) => self.make_node(v, to),
                    None => return,
                }
            };
            let edge = self.g.new_edge(EdgeKind::Normal, true);
            self.g.edges[edge].from = v0;
            self.g.edges[edge].to = v1n;
            self.g.nodes[v0].incident_edge = Some(edge);
            if let Some(p) = *prev_edge {
                self.g.edges[edge].prev = Some(p);
                self.g.edges[p].next = Some(edge);
            }
            *prev_edge = Some(edge);
            v0 = v1n;
            if i < last {
                let mut pe = edge;
                self.g.make_rib(&mut pe, r.start_src, r.end_src);
                *prev_edge = Some(pe);
            }
        }
        if let Some(p) = *prev_edge
            && let Some(slot) = self.edge_map.get_mut(vd_edge.usize())
        {
            *slot = p;
        }
    }

    /// Cuts a Voronoi edge into pieces short enough for a linear width change.
    fn discretize(&self, vd_edge: EdgeIndex) -> Vec<P> {
        let Ok(ed) = self.d.edge(vd_edge) else {
            return Vec::new();
        };
        let (Some(start), Some(end)) = (
            self.vertex_p(ed.vertex0()),
            self.d
                .edge_get_vertex1(vd_edge)
                .ok()
                .and_then(|v| self.vertex_p(v)),
        ) else {
            return Vec::new();
        };
        let left = self.d.edge_get_cell(vd_edge).ok();
        let right = self
            .d
            .edge_get_twin(vd_edge)
            .ok()
            .and_then(|t| self.d.edge_get_cell(t).ok());
        let (Some(left), Some(right)) = (left, right) else {
            return vec![start, end];
        };
        let point_of = |c: CellIndex| {
            self.d
                .cell(c)
                .is_ok_and(boostvoronoi::prelude::Cell::contains_point)
        };
        let (pl, pr) = (point_of(left), point_of(right));
        if (!pl && !pr) || ed.is_secondary() {
            return vec![start, end];
        }
        if pl != pr {
            let (pc, sc) = if pl { (left, right) } else { (right, left) };
            let (Some(p), Some(s)) = (self.source_point(pc), self.source_segment(sc)) else {
                return vec![start, end];
            };
            return discretize_parabola(
                p,
                s.from,
                s.to,
                start,
                end,
                self.prm.discretization_step,
                self.prm.transitioning_angle,
            );
        }
        let (Some(lp), Some(rp)) = (self.source_point(left), self.source_point(right)) else {
            return vec![start, end];
        };
        discretize_between_points(
            lp,
            rp,
            start,
            end,
            self.prm.discretization_step,
            self.prm.transitioning_angle,
        )
    }
}

/// A node that starts more than one quad is split, so every quad start has a node of its own.
fn separate_pointy_quad_end_nodes(g: &mut Graph) {
    let mut visited = vec![false; g.nodes.len()];
    for e in g.live_edges() {
        if g.edges[e].prev.is_some() {
            continue;
        }
        let from = g.edges[e].from;
        if from >= visited.len() {
            visited.resize(from + 1, false);
        }
        if !std::mem::replace(&mut visited[from], true) {
            continue;
        }
        let mut copy = g.nodes[from].clone();
        copy.incident_edge = Some(e);
        let id = g.nodes.len();
        g.nodes.push(copy);
        g.node_order.push_back(id);
        g.edges[e].from = id;
        if let Some(t) = g.edges[e].twin {
            g.edges[t].to = id;
        }
    }
}

/// Whether `query` lies inside the corner `a`, `b`, `c` of a counter-clockwise outline.
fn inside_corner(a: P, b: P, c: P, query: P) -> bool {
    let norm = |p: P, o: P| {
        #[allow(clippy::cast_precision_loss, reason = "coordinates in nm")]
        let (x, y) = ((p.x - o.x) as f64, (p.y - o.y) as f64);
        let l = x.m_hypot(y);
        if l == 0.0 { (0.0, 0.0) } else { (x / l, y / l) }
    };
    let (ba, bc, bq) = (norm(a, b), norm(c, b), norm(query, b));
    let normal = (-bq.1, bq.0);
    let dot = |u: (f64, f64), v: (f64, f64)| u.0 * v.0 + u.1 * v.1;
    let pa = dot(ba, normal);
    let pc = dot(bc, normal);
    if (pa > 0.0 && pc <= 0.0) || (pa <= 0.0 && pc > 0.0) {
        return pa > 0.0;
    }
    let (qa, qc) = (dot(ba, bq), dot(bc, bq));
    (pa > 0.0 && qc < qa) || (pa <= 0.0 && qc >= qa)
}

/// The parabola between a point and a segment, as short straight pieces with the marks where the
/// transition angle puts a bend and at the apex.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "coordinates in nm, counts are small"
)]
fn discretize_parabola(source: P, a: P, b: P, start: P, end: P, step_size: i64, angle: f64) -> Vec<P> {
    let ab = b.minus(a);
    let ab_size = ab.len();
    if ab_size == 0 {
        return vec![start, end];
    }
    let sx = start.minus(a).dot(ab) / ab_size;
    let ex = end.minus(a).dot(ab) / ab_size;
    let sxex = ex - sx;
    let px = source.minus(a).dot(ab) / ab_size;
    let pxx = closest_on_line(a, b, source);
    let ppxx = pxx.minus(source);
    let d = ppxx.len();
    if d == 0 {
        return vec![start, end];
    }
    // The perpendicular of ppxx, normalized, is the rotation of the parabola's frame.
    let len = ppxx.len_f();
    let (cos, sin) = (-(ppxx.y as f64) / len, ppxx.x as f64 / len);
    let rotate = |x: i64, y: i64| -> P {
        let (xf, yf) = (x as f64, y as f64);
        P::new((xf * cos - yf * sin) as i64, (xf * sin + yf * cos) as i64)
    };
    let marking_bound = (angle * 0.5).m_atan();
    let mut msx = (-marking_bound * d as f64) as i64;
    let mut mex = (marking_bound * d as f64) as i64;
    let mark_h = msx * msx / (2 * d) + d / 2;
    let mut marking_start = rotate(msx, mark_h).plus(pxx);
    let mut marking_end = rotate(mex, mark_h).plus(pxx);
    let dir: i64 = if sx > ex { -1 } else { 1 };
    if dir < 0 {
        std::mem::swap(&mut marking_start, &mut marking_end);
        std::mem::swap(&mut msx, &mut mex);
    }
    let mut add_marking_start = msx * dir > (sx - px) * dir && msx * dir < (ex - px) * dir;
    let mut add_marking_end = mex * dir > (sx - px) * dir && mex * dir < (ex - px) * dir;
    let apex = rotate(0, d / 2).plus(pxx);
    let mut add_apex = (sx - px) * dir < 0 && (ex - px) * dir > 0;
    let step_count = ((ex - sx).abs() as f64 / step_size as f64).round() as i64;
    let mut out = vec![start];
    for step in 1..step_count {
        let x = sx + sxex * step / step_count - px;
        let y = x * x / (2 * d) + d / 2;
        if add_marking_start && msx * dir < x * dir {
            out.push(marking_start);
            add_marking_start = false;
        }
        if add_apex && x * dir > 0 {
            out.push(apex);
            add_apex = false;
        }
        if add_marking_end && mex * dir < x * dir {
            out.push(marking_end);
            add_marking_end = false;
        }
        out.push(rotate(x, y).plus(pxx));
    }
    if add_apex {
        out.push(apex);
    }
    if add_marking_end {
        out.push(marking_end);
    }
    out.push(end);
    out
}

/// The straight edge between two points: the width along it is not linear either, so it is cut up,
/// with marks at the positions where the transition angle bends the width.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "coordinates in nm, counts are small"
)]
fn discretize_between_points(left: P, right: P, start: P, end: P, step_size: i64, angle: f64) -> Vec<P> {
    let d = dist(right, left);
    let middle = P::new(i64::midpoint(left.x, right.x), i64::midpoint(left.y, right.y));
    let lr = right.minus(left);
    let x_axis = P::new(-lr.y, lr.x);
    let x_len = x_axis.len();
    if x_len == 0 {
        return vec![start, end];
    }
    let projected = |from: P| from.minus(middle).dot(x_axis) / x_len;
    let start_x = projected(start);
    let end_x = projected(end);
    let bound = 0.5 / ((std::f64::consts::PI - angle) * 0.5).m_tan();
    let mut marking_start_x = (-(d as f64) * bound) as i64;
    let mut marking_end_x = (d as f64 * bound) as i64;
    let on_axis = |x: i64| P::new(middle.x + x_axis.x * x / x_len, middle.y + x_axis.y * x / x_len);
    let mut marking_start = on_axis(marking_start_x);
    let mut marking_end = on_axis(marking_end_x);
    let mut direction: i64 = 1;
    if start_x > end_x {
        direction = -1;
        std::mem::swap(&mut marking_start, &mut marking_end);
        std::mem::swap(&mut marking_start_x, &mut marking_end_x);
    }
    let mut add_marking_start = marking_start_x * direction > start_x * direction;
    let mut add_marking_end = marking_end_x * direction > start_x * direction;
    let ab = end.minus(start);
    let ab_size = ab.len();
    let mut step_count = (ab_size + step_size / 2) / step_size.max(1);
    if step_count % 2 == 1 {
        step_count += 1;
    }
    let mut out = vec![start];
    for step in 1..step_count {
        let here = P::new(
            start.x + ab.x * step / step_count,
            start.y + ab.y * step / step_count,
        );
        let x_here = projected(here);
        if add_marking_start && marking_start_x * direction < x_here * direction {
            out.push(marking_start);
            add_marking_start = false;
        }
        if add_marking_end && marking_end_x * direction < x_here * direction {
            out.push(marking_end);
            add_marking_end = false;
        }
        out.push(here);
    }
    if add_marking_end && marking_end_x * direction < end_x * direction {
        out.push(marking_end);
    }
    out.push(end);
    out
}
