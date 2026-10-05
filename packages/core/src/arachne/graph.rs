// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The skeletal graph: the medial axis of the outline as a half-edge structure, where every cell of
//! the Voronoi diagram becomes a quad (two "ribs" from the outline to the skeleton and the skeleton
//! edges between them). Nodes and edges are indices into vectors; removed ones stay as dead slots so
//! indices never move, and `edge_order` keeps the order the edges are visited in, which some passes
//! depend on (new edges go to the front or the back of it the way the algorithm creates them).
#![allow(
    clippy::indexing_slicing,
    reason = "nodes and edges are vector indices that the graph keeps valid"
)]

use crate::fm::Fm as _;
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Hash)]
pub(crate) struct P {
    pub(crate) x: i64,
    pub(crate) y: i64,
}

impl P {
    pub(crate) fn new(x: i64, y: i64) -> Self {
        Self { x, y }
    }
    pub(crate) fn minus(self, o: P) -> P {
        P::new(self.x - o.x, self.y - o.y)
    }
    pub(crate) fn plus(self, o: P) -> P {
        P::new(self.x + o.x, self.y + o.y)
    }
    pub(crate) fn dot(self, o: P) -> i64 {
        self.x * o.x + self.y * o.y
    }
    pub(crate) fn len_f(self) -> f64 {
        #[allow(clippy::cast_precision_loss, reason = "lengths in nm")]
        let (x, y) = (self.x as f64, self.y as f64);
        x.m_hypot(y)
    }
    /// The length truncated to whole nanometers, as the algorithm counts distances.
    pub(crate) fn len(self) -> i64 {
        #[allow(clippy::cast_possible_truncation, reason = "a length in nm")]
        let v = self.len_f() as i64;
        v
    }
}

/// Distance between two points, truncated to whole nanometers.
pub(crate) fn dist(a: P, b: P) -> i64 {
    a.minus(b).len()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EdgeKind {
    /// From the Voronoi diagram.
    Normal,
    /// A rib added so a cell becomes a quad.
    ExtraVd,
    /// A rib added where a transition ends.
    TransitionEnd,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TransitionMid {
    /// Position along the edge from `from`.
    pub(crate) pos: i64,
    pub(crate) lower_bead_count: i64,
    pub(crate) feature_radius: i64,
    pub(crate) dead: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TransitionEnd {
    pub(crate) pos: i64,
    pub(crate) lower_bead_count: i64,
    pub(crate) is_lower_end: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Junction {
    pub(crate) p: P,
    pub(crate) w: i64,
    pub(crate) perimeter_index: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct Node {
    pub(crate) p: P,
    /// Distance to the outline; -1 until known.
    pub(crate) dist: i64,
    /// Bead count; -1 until known.
    pub(crate) bead_count: i64,
    pub(crate) transition_ratio: f64,
    pub(crate) incident_edge: Option<usize>,
    pub(crate) beading: Option<usize>,
    pub(crate) alive: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct Edge {
    pub(crate) from: usize,
    pub(crate) to: usize,
    pub(crate) twin: Option<usize>,
    pub(crate) next: Option<usize>,
    pub(crate) prev: Option<usize>,
    pub(crate) kind: EdgeKind,
    pub(crate) central: Option<bool>,
    pub(crate) transitions: Option<Vec<TransitionMid>>,
    pub(crate) transition_ends: Option<Vec<TransitionEnd>>,
    pub(crate) junctions: Option<Vec<Junction>>,
    pub(crate) alive: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Graph {
    pub(crate) nodes: Vec<Node>,
    pub(crate) edges: Vec<Edge>,
    /// Edge ids in the order the algorithm walks them.
    pub(crate) edge_order: VecDeque<usize>,
    /// Node ids in creation order (new nodes at the back, or the front for ribs).
    pub(crate) node_order: VecDeque<usize>,
}

/// Emptied graphs whose buffers the next graphs reuse, shared by all threads (one per graph being built
/// at the same time at most).
static SPARE: std::sync::Mutex<Vec<Graph>> = std::sync::Mutex::new(Vec::new());

impl Graph {
    /// An empty graph on the buffers of one that was recycled. A large island's graph takes tens of
    /// megabytes in a few large blocks; freed, the system allocator keeps such blocks mapped and reuses
    /// them poorly, so a slice that built a new graph for every layer of a large island held hundreds of
    /// megabytes of freed blocks at its peak. Only the capacity of the buffers carries over, never content.
    pub(crate) fn reused() -> Self {
        SPARE.lock().ok().and_then(|mut s| s.pop()).unwrap_or_default()
    }

    /// Empties the graph and keeps its buffers for a later [`Graph::reused`].
    pub(crate) fn recycle(mut self) {
        self.nodes.clear();
        self.edges.clear();
        self.edge_order.clear();
        self.node_order.clear();
        if let Ok(mut s) = SPARE.lock() {
            s.push(self);
        }
    }

    pub(crate) fn new_node(&mut self, p: P, front: bool) -> usize {
        let id = self.nodes.len();
        self.nodes.push(Node {
            p,
            dist: -1,
            bead_count: -1,
            transition_ratio: 0.0,
            incident_edge: None,
            beading: None,
            alive: true,
        });
        if front {
            self.node_order.push_front(id);
        } else {
            self.node_order.push_back(id);
        }
        id
    }

    pub(crate) fn new_edge(&mut self, kind: EdgeKind, front: bool) -> usize {
        let id = self.edges.len();
        self.edges.push(Edge {
            from: usize::MAX,
            to: usize::MAX,
            twin: None,
            next: None,
            prev: None,
            kind,
            central: None,
            transitions: None,
            transition_ends: None,
            junctions: None,
            alive: true,
        });
        if front {
            self.edge_order.push_front(id);
        } else {
            self.edge_order.push_back(id);
        }
        id
    }

    pub(crate) fn live_edges(&self) -> Vec<usize> {
        self.edge_order
            .iter()
            .copied()
            .filter(|e| self.edges[*e].alive)
            .collect()
    }

    pub(crate) fn live_nodes(&self) -> Vec<usize> {
        self.node_order
            .iter()
            .copied()
            .filter(|n| self.nodes[*n].alive)
            .collect()
    }

    pub(crate) fn edge_len(&self, e: usize) -> i64 {
        dist(self.nodes[self.edges[e].from].p, self.nodes[self.edges[e].to].p)
    }

    /// The edge leaving `e`'s end node that follows `e` around the node, the way the loop
    /// `edge = edge.twin.next` walks the edges of a node.
    pub(crate) fn rot_next(&self, e: usize) -> Option<usize> {
        self.edges[self.edges[e].twin?].next
    }

    // Edge and node predicates of the skeleton.

    pub(crate) fn is_central(&self, e: usize) -> bool {
        self.edges[e].central == Some(true)
    }

    pub(crate) fn central_set(&self, e: usize) -> bool {
        self.edges[e].central.is_some()
    }

    /// Whether the edge can reach a node that is farther from the outline.
    pub(crate) fn can_go_up(&self, e: usize, strict: bool) -> bool {
        let (f, t) = (&self.nodes[self.edges[e].from], &self.nodes[self.edges[e].to]);
        if t.dist > f.dist {
            return true;
        }
        if t.dist < f.dist || strict {
            return false;
        }
        let Some(twin) = self.edges[e].twin else {
            return false;
        };
        let mut outgoing = self.edges[e].next;
        let mut guard = 0;
        while let Some(o) = outgoing {
            if o == twin || guard > 100_000 {
                break;
            }
            guard += 1;
            if self.can_go_up(o, false) {
                return true;
            }
            match self.rot_next(o) {
                Some(n) => outgoing = Some(n),
                None => return true,
            }
        }
        false
    }

    /// The distance to the first edge going up, when this one is level.
    pub(crate) fn dist_to_go_up(&self, e: usize) -> Option<i64> {
        let (f, t) = (&self.nodes[self.edges[e].from], &self.nodes[self.edges[e].to]);
        if t.dist > f.dist {
            return Some(0);
        }
        if t.dist < f.dist {
            return None;
        }
        let twin = self.edges[e].twin?;
        let mut ret: Option<i64> = None;
        let mut outgoing = self.edges[e].next;
        let mut guard = 0;
        while let Some(o) = outgoing {
            if o == twin || guard > 100_000 {
                break;
            }
            guard += 1;
            if let Some(d) = self.dist_to_go_up(o) {
                ret = Some(ret.map_or(d, |r| r.min(d)));
            }
            match self.rot_next(o) {
                Some(n) => outgoing = Some(n),
                None => return Some(0),
            }
        }
        ret.map(|r| r + dist(f.p, t.p))
    }

    /// Whether the edge goes from a lower to a higher distance from the outline; level edges look
    /// beyond themselves, and ties go by position so an edge and its twin disagree.
    pub(crate) fn is_upward(&self, e: usize) -> bool {
        let (f, t) = (&self.nodes[self.edges[e].from], &self.nodes[self.edges[e].to]);
        if t.dist > f.dist {
            return true;
        }
        if t.dist < f.dist {
            return false;
        }
        let forward = self.dist_to_go_up(e);
        let backward = self.edges[e].twin.and_then(|tw| self.dist_to_go_up(tw));
        match (forward, backward) {
            (Some(a), Some(b)) => a < b,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => t.p < f.p,
        }
    }

    /// The edge of a quad's far end, following `next` links, then the twin of the last one.
    pub(crate) fn next_unconnected(&self, e: usize) -> Option<usize> {
        let mut r = e;
        let mut guard = 0;
        while let Some(n) = self.edges[r].next {
            r = n;
            if r == e || guard > 100_000 {
                return None;
            }
            guard += 1;
        }
        self.edges[r].twin
    }

    pub(crate) fn is_multi_intersection(&self, n: usize) -> bool {
        let Some(start) = self.nodes[n].incident_edge else {
            return false;
        };
        let mut count = 0;
        let mut o = start;
        let mut guard = 0;
        loop {
            if self.is_central(o) {
                count += 1;
            }
            match self.rot_next(o) {
                Some(nx) if nx != start && guard < 100_000 => o = nx,
                Some(_) => break,
                None => return false,
            }
            guard += 1;
        }
        count > 2
    }

    pub(crate) fn node_is_central(&self, n: usize) -> bool {
        let Some(start) = self.nodes[n].incident_edge else {
            return false;
        };
        let mut e = start;
        let mut guard = 0;
        loop {
            if self.is_central(e) {
                return true;
            }
            match self.rot_next(e) {
                Some(nx) if nx != start && guard < 100_000 => e = nx,
                _ => return false,
            }
            guard += 1;
        }
    }

    pub(crate) fn is_local_maximum(&self, n: usize, strict: bool) -> bool {
        if self.nodes[n].dist == 0 {
            return false;
        }
        let Some(start) = self.nodes[n].incident_edge else {
            return false;
        };
        let mut e = start;
        let mut guard = 0;
        loop {
            if self.can_go_up(e, strict) {
                return false;
            }
            match self.rot_next(e) {
                None => return false,
                Some(nx) if nx != start && guard < 100_000 => e = nx,
                Some(_) => return true,
            }
            guard += 1;
        }
    }

    /// The segment of the outline the quad containing `e` stands on.
    pub(crate) fn source_segment(&self, e: usize) -> (P, P) {
        let mut first = e;
        while let Some(p) = self.edges[first].prev {
            first = p;
        }
        let mut last = e;
        while let Some(n) = self.edges[last].next {
            last = n;
        }
        (
            self.nodes[self.edges[first].from].p,
            self.nodes[self.edges[last].to].p,
        )
    }

    /// Closes the quad at `prev_edge` with a rib down to the source segment: a node on the
    /// segment, an edge out to it and one back, and `prev_edge` becomes the way back.
    pub(crate) fn make_rib(&mut self, prev_edge: &mut usize, start_src: P, end_src: P) {
        let to = self.edges[*prev_edge].to;
        let q = closest_on_line(start_src, end_src, self.nodes[to].p);
        let d = dist(self.nodes[to].p, q);
        self.nodes[to].dist = d;
        let node = self.new_node(q, true);
        self.nodes[node].dist = 0;
        let forth = self.new_edge(EdgeKind::ExtraVd, true);
        let back = self.new_edge(EdgeKind::ExtraVd, true);
        self.edges[*prev_edge].next = Some(forth);
        self.edges[forth].prev = Some(*prev_edge);
        self.edges[forth].from = to;
        self.edges[forth].to = node;
        self.edges[forth].twin = Some(back);
        self.edges[back].twin = Some(forth);
        self.edges[back].from = node;
        self.edges[back].to = to;
        self.nodes[node].incident_edge = Some(back);
        *prev_edge = back;
    }

    /// Splits `edge` at a new node `mid_node` with a rib from it to the source segment; returns the
    /// two edges that replace it.
    fn insert_rib(&mut self, edge: usize, mid_node: usize) -> (usize, usize) {
        let edge_before = self.edges[edge].prev;
        let edge_after = self.edges[edge].next;
        let node_before = self.edges[edge].from;
        let node_after = self.edges[edge].to;
        let p = self.nodes[mid_node].p;
        let (sa, sb) = self.source_segment(edge);
        let px = closest_on_segment(sa, sb, p);
        let d = dist(p, px);
        self.nodes[mid_node].dist = d;
        self.nodes[mid_node].transition_ratio = 0.0;
        let source_node = self.new_node(px, false);
        self.nodes[source_node].dist = 0;
        let first = edge;
        let second = self.new_edge(EdgeKind::Normal, false);
        let outward = self.new_edge(EdgeKind::TransitionEnd, false);
        let inward = self.new_edge(EdgeKind::TransitionEnd, false);
        if let Some(b) = edge_before {
            self.edges[b].next = Some(first);
        }
        self.edges[first].next = Some(outward);
        self.edges[outward].next = None;
        self.edges[inward].next = Some(second);
        self.edges[second].next = edge_after;
        if let Some(a) = edge_after {
            self.edges[a].prev = Some(second);
        }
        self.edges[second].prev = Some(inward);
        self.edges[inward].prev = None;
        self.edges[outward].prev = Some(first);
        self.edges[first].prev = edge_before;
        self.edges[first].to = mid_node;
        self.edges[outward].to = source_node;
        self.edges[inward].to = mid_node;
        self.edges[second].to = node_after;
        self.edges[first].from = node_before;
        self.edges[outward].from = mid_node;
        self.edges[inward].from = source_node;
        self.edges[second].from = mid_node;
        self.nodes[node_before].incident_edge = Some(first);
        self.nodes[mid_node].incident_edge = Some(outward);
        self.nodes[source_node].incident_edge = Some(inward);
        if let Some(a) = edge_after {
            self.nodes[node_after].incident_edge = Some(a);
        }
        self.edges[first].central = Some(true);
        self.edges[outward].central = Some(false);
        self.edges[inward].central = Some(false);
        self.edges[second].central = Some(true);
        self.edges[outward].twin = Some(inward);
        self.edges[inward].twin = Some(outward);
        self.edges[first].twin = None;
        self.edges[second].twin = None;
        (first, second)
    }

    /// Puts a node on `edge` at `mid`, with ribs to the source segment on both sides; returns the
    /// last edge replacing `edge`, which still ends at the same node.
    pub(crate) fn insert_node(&mut self, edge: usize, mid: P, bead_count: i64) -> usize {
        let mid_node = self.new_node(mid, false);
        let Some(twin) = self.edges[edge].twin else {
            return edge;
        };
        self.edges[edge].twin = None;
        self.edges[twin].twin = None;
        let left = self.insert_rib(edge, mid_node);
        let right = self.insert_rib(twin, mid_node);
        self.edges[left.0].twin = Some(right.1);
        self.edges[right.1].twin = Some(left.0);
        self.edges[left.1].twin = Some(right.0);
        self.edges[right.0].twin = Some(left.1);
        self.nodes[mid_node].bead_count = bead_count;
        left.1
    }

    /// Merges nodes closer together than `snap` (as whole cells or single skeleton edges) so the
    /// quads stay consistent.
    pub(crate) fn collapse_small_edges(&mut self, snap: i64) {
        let should = |g: &Graph, a: usize, b: usize| dist(g.nodes[a].p, g.nodes[b].p) < snap;
        let order: Vec<usize> = self.edge_order.iter().copied().collect();
        for e in order {
            if !self.edges[e].alive || self.edges[e].prev.is_some() {
                continue;
            }
            let quad_start = e;
            let mut quad_end = quad_start;
            let mut guard = 0;
            while let Some(n) = self.edges[quad_end].next {
                quad_end = n;
                guard += 1;
                if guard > 100_000 {
                    break;
                }
            }
            let quad_mid = if self.edges[quad_start].next == Some(quad_end) {
                None
            } else {
                self.edges[quad_start].next
            };
            if let Some(mid) = quad_mid
                && should(self, self.edges[mid].from, self.edges[mid].to)
            {
                let Some(mid_twin) = self.edges[mid].twin else {
                    continue;
                };
                let mid_from = self.edges[mid].from;
                let mid_to = self.edges[mid].to;
                let mut count = 0;
                let mut e3 = Some(quad_end);
                while let Some(x) = e3 {
                    if x == mid_twin {
                        break;
                    }
                    self.edges[x].from = mid_from;
                    if let Some(t) = self.edges[x].twin {
                        self.edges[t].to = mid_from;
                    }
                    count += 1;
                    if count > 1000 {
                        break;
                    }
                    e3 = self.rot_next(x);
                }
                if self.nodes[mid_from].incident_edge == Some(mid) {
                    self.nodes[mid_from].incident_edge = match self.edges[mid_twin].next {
                        Some(n) => Some(n),
                        None => self.edges[mid].prev.and_then(|p| self.edges[p].twin),
                    };
                }
                self.nodes[mid_to].alive = false;
                let (mp, mn) = (self.edges[mid].prev, self.edges[mid].next);
                if let Some(p) = mp {
                    self.edges[p].next = mn;
                }
                if let Some(n) = mn {
                    self.edges[n].prev = mp;
                }
                let (tp, tn) = (self.edges[mid_twin].prev, self.edges[mid_twin].next);
                if let Some(n) = tn {
                    self.edges[n].prev = tp;
                }
                if let Some(p) = tp {
                    self.edges[p].next = tn;
                }
                self.edges[mid_twin].alive = false;
                self.edges[mid].alive = false;
            }
            // Still the same quad? Then collapse its start and end edges and drop the whole cell.
            if !self.edges[quad_start].alive || !self.edges[quad_end].alive {
                continue;
            }
            if should(self, self.edges[quad_start].from, self.edges[quad_end].to)
                && should(self, self.edges[quad_start].to, self.edges[quad_end].from)
            {
                let qs_twin = self.edges[quad_start].twin;
                let qe_twin = self.edges[quad_end].twin;
                let (Some(qs_twin), Some(qe_twin)) = (qs_twin, qe_twin) else {
                    continue;
                };
                let end_to = self.edges[quad_end].to;
                self.edges[qs_twin].to = end_to;
                self.nodes[end_to].incident_edge = Some(qe_twin);
                let end_from = self.edges[quad_end].from;
                if self.nodes[end_from].incident_edge == Some(quad_end) {
                    self.nodes[end_from].incident_edge = match self.edges[qe_twin].next {
                        Some(n) => Some(n),
                        None => self.edges[quad_end].prev.and_then(|p| self.edges[p].twin),
                    };
                }
                self.nodes[self.edges[quad_start].from].alive = false;
                self.edges[qs_twin].twin = Some(qe_twin);
                self.edges[qe_twin].twin = Some(qs_twin);
                self.edges[quad_start].alive = false;
                self.edges[quad_end].alive = false;
            }
        }
    }
}

/// The closest point to `p` on the infinite line through `a` and `b`.
pub(crate) fn closest_on_line(a: P, b: P, p: P) -> P {
    let ab = b.minus(a);
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        reason = "coordinates in nm"
    )]
    {
        let l2 = ab.dot(ab) as f64;
        if l2 == 0.0 {
            return a;
        }
        let t = p.minus(a).dot(ab) as f64 / l2;
        P::new(
            a.x + (ab.x as f64 * t).round() as i64,
            a.y + (ab.y as f64 * t).round() as i64,
        )
    }
}

/// The closest point to `p` on the segment from `a` to `b`.
pub(crate) fn closest_on_segment(a: P, b: P, p: P) -> P {
    let ab = b.minus(a);
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        reason = "coordinates in nm"
    )]
    {
        let l2 = ab.dot(ab) as f64;
        if l2 == 0.0 {
            return a;
        }
        let t = (p.minus(a).dot(ab) as f64 / l2).clamp(0.0, 1.0);
        P::new(
            a.x + (ab.x as f64 * t).round() as i64,
            a.y + (ab.y as f64 * t).round() as i64,
        )
    }
}
