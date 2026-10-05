// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The skeletal trapezoidation: from the skeletal graph to variable-width wall lines.
//!
//! Picture the outline filled with the union of cones standing on its edges; the graph is the
//! ridge of that surface, each node knowing its radius (distance to the outline). Where the ridge
//! is flat enough (an angle limit on the two outline edges the region sits between) it is
//! "central": the wall there is a whole number of beads across, chosen by the beading strategy from
//! the radius. Where the bead count changes along a central edge, a transition is placed and spread
//! over a length; the beadings are then carried from the central nodes outward and every quad is cut
//! into line junctions, which connect across the quad into wall lines.
#![allow(
    clippy::indexing_slicing,
    reason = "nodes, edges and beadings are vector indices that the graph keeps valid"
)]

use super::beading::{Beading, Strategy};
use super::graph::{EdgeKind, Graph, Junction, P, TransitionEnd, TransitionMid, dist};
use super::voronoi;
use crate::fm::Fm as _;

/// A line of wall: junctions with widths, and what kind of wall it is.
#[derive(Debug, Clone)]
pub(crate) struct Line {
    pub(crate) inset_idx: usize,
    pub(crate) is_odd: bool,
    pub(crate) is_closed: bool,
    pub(crate) junctions: Vec<Junction>,
}

#[derive(Debug, Clone)]
struct BeadingProp {
    beading: Beading,
    dist_to_bottom_source: i64,
    dist_from_top_source: i64,
    is_upward_propagated_only: bool,
}

impl BeadingProp {
    fn new(beading: Beading) -> Self {
        Self {
            beading,
            dist_to_bottom_source: 0,
            dist_from_top_source: 0,
            is_upward_propagated_only: false,
        }
    }
}

pub(crate) struct Settings {
    /// Keep the Voronoi diagram for another run on the same rings ([`super::Params::keep_diagram`]).
    pub(crate) keep_diagram: bool,
    pub(crate) transitioning_angle: f64,
    pub(crate) discretization_step: i64,
    pub(crate) transition_filter_dist: i64,
    pub(crate) allowed_filter_deviation: i64,
    pub(crate) propagation_transition_dist: i64,
}

fn nm(mm: f64) -> i64 {
    super::beading::nm(mm)
}

/// Generates the wall lines of the rings (outer counter-clockwise, holes clockwise), by inset index.
pub(crate) fn generate(rings: &[Vec<P>], strat: &dyn Strategy, st: &Settings) -> Option<Vec<Vec<Line>>> {
    let prm = voronoi::Params {
        transitioning_angle: st.transitioning_angle,
        discretization_step: st.discretization_step,
        keep: st.keep_diagram,
    };
    let graph = voronoi::build(rings, &prm)?;
    let mut sk = Skeleton {
        g: graph,
        strat,
        st,
        beadings: Vec::new(),
        out: Vec::new(),
    };
    sk.run();
    let Skeleton { g, out, .. } = sk;
    g.recycle();
    Some(out)
}

struct Skeleton<'a> {
    g: Graph,
    strat: &'a dyn Strategy,
    st: &'a Settings,
    beadings: Vec<BeadingProp>,
    out: Vec<Vec<Line>>,
}

/// A transition on an edge: which edge and which entry of its list.
type TransitionRef = (usize, usize);

impl Skeleton<'_> {
    fn snap_dist() -> i64 {
        nm(0.02)
    }

    fn run(&mut self) {
        self.update_is_central();
        self.update_bead_count();
        self.filter_noncentral_regions();
        self.generate_transitioning_ribs();
        self.generate_extra_ribs();
        self.generate_segments();
    }

    // Central edges.

    fn update_is_central(&mut self) {
        let outer_edge_filter_length = self.strat.transition_thickness(0) / 2;
        let cap = (self.strat.transitioning_angle() * 0.5).m_sin();
        for e in self.g.live_edges() {
            let Some(twin) = self.g.edges[e].twin else {
                continue;
            };
            if self.g.central_set(twin) {
                self.g.edges[e].central = self.g.edges[twin].central;
                continue;
            }
            if self.g.edges[e].kind == EdgeKind::ExtraVd {
                self.g.edges[e].central = Some(false);
                continue;
            }
            let (f, t) = (
                &self.g.nodes[self.g.edges[e].from],
                &self.g.nodes[self.g.edges[e].to],
            );
            if f.dist.max(t.dist) < outer_edge_filter_length {
                self.g.edges[e].central = Some(false);
                continue;
            }
            let d_r = (t.dist - f.dist).abs();
            let d_d = dist(f.p, t.p);
            #[allow(clippy::cast_precision_loss, reason = "lengths in nm")]
            let central = (d_r as f64) < d_d as f64 * cap;
            self.g.edges[e].central = Some(central);
        }
    }

    fn update_bead_count(&mut self) {
        for e in self.g.live_edges() {
            if self.g.is_central(e) {
                let to = self.g.edges[e].to;
                self.g.nodes[to].bead_count = self.strat.optimal_bead_count(self.g.nodes[to].dist * 2);
            }
        }
        for n in self.g.live_nodes() {
            if self.g.is_local_maximum(n, false) {
                if self.g.nodes[n].dist < 0 {
                    let mut best = i64::MAX;
                    if let Some(start) = self.g.nodes[n].incident_edge {
                        let mut e = start;
                        let mut guard = 0;
                        loop {
                            let to = self.g.edges[e].to;
                            best = best.min(self.g.nodes[to].dist + self.g.edge_len(e));
                            match self.g.rot_next(e) {
                                Some(nx) if nx != start && guard < 10_000 => e = nx,
                                _ => break,
                            }
                            guard += 1;
                        }
                    }
                    self.g.nodes[n].dist = best;
                }
                self.g.nodes[n].bead_count = self.strat.optimal_bead_count(self.g.nodes[n].dist * 2);
            }
        }
    }

    /// Whether `e` is the last central edge of a central region (nothing central goes on after it).
    fn is_end_of_central(&self, e: usize) -> bool {
        if !self.g.is_central(e) {
            return false;
        }
        let Some(mut edge) = self.g.edges[e].next else {
            return true;
        };
        let twin = self.g.edges[e].twin;
        let mut guard = 0;
        loop {
            if Some(edge) == twin || guard > 100_000 {
                return true;
            }
            if self.g.is_central(edge) {
                return false;
            }
            match self.g.rot_next(edge) {
                Some(n) => edge = n,
                None => return true,
            }
            guard += 1;
        }
    }

    fn filter_noncentral_regions(&mut self) {
        for e in self.g.live_edges() {
            if !self.is_end_of_central(e) {
                continue;
            }
            let to = self.g.edges[e].to;
            let bead_count = self.g.nodes[to].bead_count;
            self.filter_noncentral(e, bead_count, 0, nm(0.4));
        }
    }

    /// Extends a central region outward for up to `max_dist` where going upward meets the same bead
    /// count, or one off; returns whether the region beyond was absorbed.
    fn filter_noncentral(&mut self, to_edge: usize, bead_count: i64, traveled: i64, max_dist: i64) -> bool {
        let r = self.g.nodes[self.g.edges[to_edge].to].dist;
        let twin = self.g.edges[to_edge].twin;
        let mut next = self.g.edges[to_edge].next;
        let mut guard = 0;
        while let Some(ne) = next {
            if Some(ne) == twin || guard > 100_000 {
                break;
            }
            let (nf, nt) = (
                &self.g.nodes[self.g.edges[ne].from],
                &self.g.nodes[self.g.edges[ne].to],
            );
            // Only walk upward.
            if nt.dist >= r || short(nt.p.minus(nf.p), nm(0.01)) {
                break;
            }
            next = self.g.rot_next(ne);
            guard += 1;
        }
        let Some(ne) = next else { return false };
        if Some(ne) == twin {
            return false;
        }
        let length = self.g.edge_len(ne);
        let nt_node = self.g.edges[ne].to;
        let dissolve = if self.g.nodes[nt_node].bead_count == bead_count {
            true
        } else if self.g.nodes[nt_node].bead_count < 0 {
            self.filter_noncentral(ne, bead_count, traveled + length, max_dist)
        } else {
            traveled + length < max_dist && (self.g.nodes[nt_node].bead_count - bead_count).abs() == 1
        };
        if dissolve {
            self.g.edges[ne].central = Some(true);
            if let Some(t) = self.g.edges[ne].twin {
                self.g.edges[t].central = Some(true);
            }
            self.g.nodes[nt_node].bead_count = self.strat.optimal_bead_count(self.g.nodes[nt_node].dist * 2);
            self.g.nodes[nt_node].transition_ratio = 0.0;
        }
        dissolve
    }

    // Transitions.

    fn generate_transitioning_ribs(&mut self) {
        self.generate_transition_mids();
        self.filter_transition_mids();
        self.generate_all_transition_ends();
        self.apply_transitions();
    }

    fn generate_transition_mids(&mut self) {
        for e in self.g.live_edges() {
            if !self.g.is_central(e) {
                continue;
            }
            let (from, to) = (self.g.edges[e].from, self.g.edges[e].to);
            let (start_r, end_r) = (self.g.nodes[from].dist, self.g.nodes[to].dist);
            let (start_bc, end_bc) = (self.g.nodes[from].bead_count, self.g.nodes[to].bead_count);
            if start_r >= end_r || start_bc == end_bc {
                continue;
            }
            let edge_size = self.g.edge_len(e);
            for lower in start_bc..end_bc {
                let mut mid_r = self.strat.transition_thickness(lower) / 2;
                mid_r = mid_r.min(end_r).max(start_r);
                let mid_pos = edge_size * (mid_r - start_r) / (end_r - start_r);
                self.g.edges[e]
                    .transitions
                    .get_or_insert_with(Vec::new)
                    .push(TransitionMid {
                        pos: mid_pos,
                        lower_bead_count: lower,
                        feature_radius: mid_r,
                        dead: false,
                    });
            }
        }
    }

    fn alive_transitions(&self, e: usize) -> Vec<usize> {
        self.g.edges[e]
            .transitions
            .as_ref()
            .map(|t| {
                t.iter()
                    .enumerate()
                    .filter(|(_, m)| !m.dead)
                    .map(|(i, _)| i)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn has_transitions(&self, e: usize) -> bool {
        !self.alive_transitions(e).is_empty()
    }

    fn filter_transition_mids(&mut self) {
        for e in self.g.live_edges() {
            if !self.has_transitions(e) {
                continue;
            }
            let ab_size = self.g.edge_len(e);
            let Some(&back_i) = self.alive_transitions(e).last() else {
                continue;
            };
            let back = self.trans(e, back_i);
            let refs =
                self.dissolve_nearby(e, back, ab_size - back.pos, self.st.transition_filter_dist, true);
            let mut should_dissolve_back = !refs.is_empty();
            for r in &refs {
                self.dissolve_bead_count_region(e, back.lower_bead_count + 1, back.lower_bead_count);
                self.kill_transition(*r);
            }
            {
                let Some(&cur_back) = self.alive_transitions(e).last() else {
                    continue;
                };
                let cb = self.trans(e, cur_back);
                let tbc = cb.lower_bead_count;
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_precision_loss,
                    reason = "lengths in nm"
                )]
                let upper_half = ((1.0 - self.strat.transition_anchor_pos(tbc))
                    * self.strat.transitioning_length(tbc) as f64) as i64;
                should_dissolve_back |=
                    self.filter_end_of_central_transition(e, ab_size - cb.pos, upper_half, tbc);
            }
            if should_dissolve_back && let Some(&i) = self.alive_transitions(e).last() {
                self.kill_transition((e, i));
            }
            let Some(&front_i) = self.alive_transitions(e).first() else {
                continue;
            };
            let Some(twin) = self.g.edges[e].twin else {
                continue;
            };
            let front = self.trans(e, front_i);
            let refs = self.dissolve_nearby(twin, front, front.pos, self.st.transition_filter_dist, false);
            let mut should_dissolve_front = !refs.is_empty();
            for r in &refs {
                self.dissolve_bead_count_region(twin, front.lower_bead_count, front.lower_bead_count + 1);
                self.kill_transition(*r);
            }
            {
                let Some(&cur_front) = self.alive_transitions(e).first() else {
                    continue;
                };
                let cf = self.trans(e, cur_front);
                let tbc = cf.lower_bead_count;
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_precision_loss,
                    reason = "lengths in nm"
                )]
                let lower_half = (self.strat.transition_anchor_pos(tbc)
                    * self.strat.transitioning_length(tbc) as f64) as i64;
                should_dissolve_front |=
                    self.filter_end_of_central_transition(twin, cf.pos, lower_half, tbc + 1);
            }
            if should_dissolve_front && let Some(&i) = self.alive_transitions(e).first() {
                self.kill_transition((e, i));
            }
        }
    }

    fn trans(&self, e: usize, i: usize) -> TransitionMid {
        self.g.edges[e].transitions.as_ref().map_or(
            TransitionMid {
                pos: 0,
                lower_bead_count: 0,
                feature_radius: 0,
                dead: true,
            },
            |t| t[i],
        )
    }

    fn kill_transition(&mut self, (e, i): TransitionRef) {
        if let Some(t) = self.g.edges[e].transitions.as_mut().and_then(|t| t.get_mut(i)) {
            t.dead = true;
        }
    }

    /// Looks around a transition for other transitions of the same kind close by, which would be
    /// dissolved together; empty when the region is too long or too varied to dissolve.
    fn dissolve_nearby(
        &self,
        edge_to_start: usize,
        origin: TransitionMid,
        traveled: i64,
        max_dist: i64,
        going_up: bool,
    ) -> Vec<TransitionRef> {
        let mut to_dissolve: Vec<TransitionRef> = Vec::new();
        if traveled > max_dist {
            return to_dissolve;
        }
        let mut should_dissolve = true;
        let twin = self.g.edges[edge_to_start].twin;
        let mut edge = self.g.edges[edge_to_start].next;
        let mut guard = 0;
        while let Some(e) = edge {
            if Some(e) == twin || guard > 100_000 {
                break;
            }
            guard += 1;
            let next_edge = self.g.rot_next(e);
            if !self.g.is_central(e) {
                edge = next_edge;
                continue;
            }
            let ab_size = self.g.edge_len(e);
            let is_aligned = self.g.is_upward(e);
            let aligned = if is_aligned {
                e
            } else {
                self.g.edges[e].twin.unwrap_or(e)
            };
            let mut seen_on_this_edge = false;
            let radius_here = self.g.nodes[self.g.edges[e].from].dist;
            let dissolve_result_is_odd = (origin.lower_bead_count % 2 != 0) == going_up;
            let width_deviation = (origin.feature_radius - radius_here).abs() * 2;
            let line_width_deviation = if dissolve_result_is_odd {
                width_deviation
            } else {
                width_deviation / 2
            };
            if line_width_deviation > self.st.allowed_filter_deviation {
                should_dissolve = false;
            }
            if should_dissolve && self.has_transitions(aligned) {
                for i in self.alive_transitions(aligned) {
                    let t = self.trans(aligned, i);
                    let pos = if is_aligned { t.pos } else { ab_size - t.pos };
                    if traveled + pos < max_dist && t.lower_bead_count == origin.lower_bead_count {
                        to_dissolve.push((aligned, i));
                        seen_on_this_edge = true;
                    }
                }
            }
            if should_dissolve && !seen_on_this_edge {
                let here = self.dissolve_nearby(e, origin, traveled + ab_size, max_dist, going_up);
                if here.is_empty() {
                    return Vec::new();
                }
                to_dissolve.extend(here);
                should_dissolve = should_dissolve && !to_dissolve.is_empty();
            }
            edge = next_edge;
        }
        if !should_dissolve {
            to_dissolve.clear();
        }
        to_dissolve
    }

    fn dissolve_bead_count_region(&mut self, edge_to_start: usize, from: i64, to: i64) {
        let end = self.g.edges[edge_to_start].to;
        if self.g.nodes[end].bead_count != from {
            return;
        }
        self.g.nodes[end].bead_count = to;
        let twin = self.g.edges[edge_to_start].twin;
        let mut edge = self.g.edges[edge_to_start].next;
        let mut guard = 0;
        while let Some(e) = edge {
            if Some(e) == twin || guard > 100_000 {
                break;
            }
            guard += 1;
            let next = self.g.rot_next(e);
            if self.g.is_central(e) {
                self.dissolve_bead_count_region(e, from, to);
            }
            edge = next;
        }
    }

    /// At the end of a central region a transition too close to the end is replaced by the lower bead
    /// count.
    fn filter_end_of_central_transition(
        &mut self,
        edge_to_start: usize,
        traveled: i64,
        max_dist: i64,
        replacing: i64,
    ) -> bool {
        if traveled > max_dist {
            return false;
        }
        let mut is_end = true;
        let mut should_dissolve = false;
        let twin = self.g.edges[edge_to_start].twin;
        let mut edge = self.g.edges[edge_to_start].next;
        let mut guard = 0;
        while let Some(e) = edge {
            if Some(e) == twin || guard > 100_000 {
                break;
            }
            guard += 1;
            let next = self.g.rot_next(e);
            if self.g.is_central(e) {
                let len = self.g.edge_len(e);
                should_dissolve |=
                    self.filter_end_of_central_transition(e, traveled + len, max_dist, replacing);
                is_end = false;
            }
            edge = next;
        }
        if is_end && traveled < max_dist {
            should_dissolve = true;
        }
        if should_dissolve {
            let to = self.g.edges[edge_to_start].to;
            self.g.nodes[to].bead_count = replacing;
        }
        should_dissolve
    }

    fn generate_all_transition_ends(&mut self) {
        for e in self.g.live_edges() {
            if !self.has_transitions(e) {
                continue;
            }
            for i in self.alive_transitions(e) {
                let t = self.trans(e, i);
                self.generate_transition_ends(e, t.pos, t.lower_bead_count);
            }
        }
    }

    fn generate_transition_ends(&mut self, edge: usize, mid_pos: i64, lower: i64) {
        let ab_size = self.g.edge_len(edge);
        let transition_length = self.strat.transitioning_length(lower);
        let mid_position = self.strat.transition_anchor_pos(lower);
        let inner_ratio = 1.0_f64;
        let start_rest = 0.0_f64;
        let mid_rest = mid_position * inner_ratio;
        let end_rest = inner_ratio;
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_precision_loss,
            reason = "lengths in nm"
        )]
        {
            // The lower bead count end.
            let start_pos = ab_size - mid_pos;
            let half = (mid_position * transition_length as f64) as i64;
            let end_pos = start_pos + half;
            if let Some(twin) = self.g.edges[edge].twin {
                self.generate_transition_end(twin, start_pos, end_pos, half, mid_rest, start_rest, lower);
            }
            // The upper bead count end.
            let half = ((1.0 - mid_position) * transition_length as f64) as i64;
            let end_pos = mid_pos + half;
            self.generate_transition_end(edge, mid_pos, end_pos, half, mid_rest, end_rest, lower);
        }
    }

    /// Puts one end of a transition at `end_pos` along `edge`, or carries it on over the next
    /// central edges when it lies beyond the edge. Returns whether every branch went downward.
    #[allow(
        clippy::too_many_arguments,
        reason = "the transition's geometry and rest values"
    )]
    fn generate_transition_end(
        &mut self,
        edge: usize,
        start_pos: i64,
        end_pos: i64,
        half_length: i64,
        start_rest: f64,
        end_rest: f64,
        lower: i64,
    ) -> bool {
        let ab_size = self.g.edge_len(edge);
        let going_up = end_rest > start_rest;
        if !self.g.is_central(edge) {
            return false;
        }
        if end_pos > ab_size {
            #[allow(clippy::cast_precision_loss, reason = "lengths in nm")]
            let rest = end_rest
                - (start_rest - end_rest) * (end_pos - ab_size) as f64 / (start_pos - end_pos) as f64;
            let twin = self.g.edges[edge].twin;
            let mut central_edge_count = 0;
            let mut o = self.g.edges[edge].next;
            let mut guard = 0;
            while let Some(x) = o {
                if Some(x) == twin || guard > 100_000 {
                    break;
                }
                guard += 1;
                if self.g.is_central(x) {
                    central_edge_count += 1;
                }
                o = self.g.rot_next(x);
            }
            let mut is_only_going_down = true;
            let mut has_recursed = false;
            let mut outgoing = self.g.edges[edge].next;
            guard = 0;
            while let Some(x) = outgoing {
                if Some(x) == twin || guard > 100_000 {
                    break;
                }
                guard += 1;
                let next = self.g.rot_next(x);
                if !self.g.is_central(x) {
                    outgoing = next;
                    continue;
                }
                if central_edge_count > 1
                    && going_up
                    && self.is_going_down(x, 0, end_pos - ab_size + half_length, lower)
                {
                    outgoing = next;
                    continue;
                }
                let down =
                    self.generate_transition_end(x, 0, end_pos - ab_size, half_length, rest, end_rest, lower);
                is_only_going_down &= down;
                outgoing = next;
                has_recursed = true;
            }
            if !going_up || (has_recursed && !is_only_going_down) {
                let to = self.g.edges[edge].to;
                self.g.nodes[to].transition_ratio = rest;
                self.g.nodes[to].bead_count = lower;
            }
            return is_only_going_down;
        }
        // An end point goes here.
        let is_lower_end = end_rest == 0.0;
        let (upward_edge, pos) = if self.g.is_upward(edge) {
            (edge, end_pos)
        } else {
            (self.g.edges[edge].twin.unwrap_or(edge), ab_size - end_pos)
        };
        let ends = self.g.edges[upward_edge]
            .transition_ends
            .get_or_insert_with(Vec::new);
        let item = TransitionEnd {
            pos,
            lower_bead_count: lower,
            is_lower_end,
        };
        if ends.first().is_none_or(|f| pos < f.pos) {
            ends.insert(0, item);
        } else {
            ends.push(item);
        }
        false
    }

    /// Whether the way on along `outgoing` leads to a lower bead count within reach.
    fn is_going_down(&self, outgoing: usize, traveled: i64, max_dist: i64, lower: i64) -> bool {
        let (f, t) = (self.g.edges[outgoing].from, self.g.edges[outgoing].to);
        if self.g.nodes[t].dist == 0 {
            return true;
        }
        let is_upward = self.g.nodes[t].dist >= self.g.nodes[f].dist;
        let upward_edge = if is_upward {
            outgoing
        } else {
            self.g.edges[outgoing].twin.unwrap_or(outgoing)
        };
        if self.g.nodes[t].bead_count > lower + 1 {
            return false;
        }
        let length = self.g.edge_len(outgoing);
        let alive = self.alive_transitions(upward_edge);
        if !alive.is_empty() {
            let i = if is_upward {
                alive[0]
            } else {
                alive[alive.len() - 1]
            };
            let mid = self.trans(upward_edge, i);
            if mid.lower_bead_count == lower
                && ((is_upward && mid.pos + traveled < max_dist)
                    || (!is_upward && length - mid.pos + traveled < max_dist))
            {
                return true;
            }
        }
        if traveled + length > max_dist {
            return false;
        }
        let tn = &self.g.nodes[t];
        if tn.bead_count <= lower && !(tn.bead_count == lower && tn.transition_ratio > 0.0) {
            return true;
        }
        let twin = self.g.edges[outgoing].twin;
        let mut is_only_going_down = true;
        let mut has_recursed = false;
        let mut next = self.g.edges[outgoing].next;
        let mut guard = 0;
        while let Some(n) = next {
            if Some(n) == twin || guard > 100_000 {
                break;
            }
            guard += 1;
            if self.g.is_central(n) {
                is_only_going_down &= self.is_going_down(n, traveled + length, max_dist, lower);
                has_recursed = true;
            }
            next = self.g.rot_next(n);
        }
        has_recursed && is_only_going_down
    }

    /// Moves the ends found on the downward edges to the upward ones, and cuts the edges where
    /// the ends are, inserting the nodes with the bead counts on each side.
    fn apply_transitions(&mut self) {
        let snap = Self::snap_dist();
        for e in self.g.live_edges() {
            let Some(twin) = self.g.edges[e].twin else {
                continue;
            };
            if self.g.edges[twin]
                .transition_ends
                .as_ref()
                .is_some_and(|t| !t.is_empty())
            {
                let length = self.g.edge_len(e);
                let twin_ends = self.g.edges[twin].transition_ends.take().unwrap_or_default();
                let ends = self.g.edges[e].transition_ends.get_or_insert_with(Vec::new);
                for end in twin_ends {
                    ends.push(TransitionEnd {
                        pos: length - end.pos,
                        ..end
                    });
                }
                self.g.edges[twin].transition_ends = Some(Vec::new());
            }
        }
        // New edges go on the back of the order, and the walk reaches them too.
        let mut i = 0;
        while i < self.g.edge_order.len() {
            let e = self.g.edge_order[i];
            i += 1;
            if !self.g.edges[e].alive {
                continue;
            }
            let Some(mut ends) = self.g.edges[e].transition_ends.clone() else {
                continue;
            };
            if ends.is_empty() {
                continue;
            }
            crate::sorting::sort_by_key(&mut ends, |t| t.pos);
            let (from, to) = (self.g.edges[e].from, self.g.edges[e].to);
            let (a, b) = (self.g.nodes[from].p, self.g.nodes[to].p);
            let ab = b.minus(a);
            let ab_size = ab.len();
            let mut last = e;
            for t in ends {
                let new_bc = if t.is_lower_end {
                    t.lower_bead_count
                } else {
                    t.lower_bead_count + 1
                };
                let end_pos = t.pos;
                let close = if end_pos < ab_size / 2 { from } else { to };
                if (end_pos < snap || end_pos > ab_size - snap) && self.g.nodes[close].bead_count == new_bc {
                    self.g.nodes[close].transition_ratio = 0.0;
                    continue;
                }
                let mid = a.plus(normal(ab, end_pos));
                last = self.g.insert_node(last, mid, new_bc);
            }
        }
    }

    fn generate_extra_ribs(&mut self) {
        let snap = Self::snap_dist();
        let mut i = 0;
        while i < self.g.edge_order.len() {
            let e = self.g.edge_order[i];
            i += 1;
            if !self.g.edges[e].alive {
                continue;
            }
            let (from, to) = (self.g.edges[e].from, self.g.edges[e].to);
            if !self.g.is_central(e)
                || short(
                    self.g.nodes[to].p.minus(self.g.nodes[from].p),
                    self.st.discretization_step,
                )
                || self.g.nodes[from].dist >= self.g.nodes[to].dist
            {
                continue;
            }
            let thicknesses = self.strat.nonlinear_thicknesses(self.g.nodes[from].bead_count);
            if thicknesses.is_empty() {
                continue;
            }
            let (a, b) = (self.g.nodes[from].p, self.g.nodes[to].p);
            let ab = b.minus(a);
            let ab_size = ab.len();
            let (a_r, b_r) = (self.g.nodes[from].dist, self.g.nodes[to].dist);
            let mut last = e;
            for t in thicknesses {
                if t / 2 <= a_r {
                    continue;
                }
                if t / 2 >= b_r {
                    break;
                }
                let new_bc = self.g.nodes[from].bead_count.min(self.g.nodes[to].bead_count);
                let end_pos = ab_size * (t / 2 - a_r) / (b_r - a_r);
                let close = if end_pos < ab_size / 2 { from } else { to };
                if (end_pos < snap || end_pos > ab_size - snap) && self.g.nodes[close].bead_count == new_bc {
                    self.g.nodes[close].transition_ratio = 0.0;
                    continue;
                }
                let mid = a.plus(normal(ab, end_pos));
                last = self.g.insert_node(last, mid, new_bc);
            }
        }
    }

    // Beadings and lines.

    fn generate_segments(&mut self) {
        let mut upward: Vec<usize> = self
            .g
            .live_edges()
            .into_iter()
            .filter(|e| {
                self.g.edges[*e].prev.is_some() && self.g.edges[*e].next.is_some() && self.g.is_upward(*e)
            })
            .collect();
        stable_sort_by(&mut upward, &|a, b| self.cmp_upward(a, b));
        for n in self.g.live_nodes() {
            let node = &self.g.nodes[n];
            if node.bead_count <= 0 {
                continue;
            }
            let (dist2, bc, ratio) = (node.dist * 2, node.bead_count, node.transition_ratio);
            let beading = if ratio == 0.0 {
                self.strat.compute(dist2, bc)
            } else {
                let low = self.strat.compute(dist2, bc);
                let high = self.strat.compute(dist2, bc + 1);
                interpolate(&low, 1.0 - ratio, &high)
            };
            self.beadings.push(BeadingProp::new(beading));
            self.g.nodes[n].beading = Some(self.beadings.len() - 1);
        }
        self.propagate_upward(&upward);
        self.propagate_downward(&upward);
        self.generate_junctions();
        self.connect_junctions();
        self.generate_local_maxima_single_beads();
    }

    fn cmp_upward(&self, a: usize, b: usize) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        let (ea, eb) = (&self.g.edges[a], &self.g.edges[b]);
        let (a_to, b_to) = (self.g.nodes[ea.to].dist, self.g.nodes[eb.to].dist);
        if a_to == b_to {
            let flat = |e: &super::graph::Edge| self.g.nodes[e.from].dist == self.g.nodes[e.to].dist;
            let (fa, fb) = (flat(ea), flat(eb));
            if fa && fb {
                let up = |e: usize| {
                    let x = self.g.dist_to_go_up(e).unwrap_or(i64::MAX);
                    let y = self.g.edges[e]
                        .twin
                        .and_then(|t| self.g.dist_to_go_up(t))
                        .unwrap_or(i64::MAX);
                    x.min(y) - self.g.edge_len(e)
                };
                return up(a).cmp(&up(b));
            }
            if fa {
                return Ordering::Less;
            }
            if fb {
                return Ordering::Greater;
            }
        }
        b_to.cmp(&a_to)
    }

    /// The edge of a quad whose end node is farthest from the outline.
    fn quad_max_r_edge_to(&self, quad_start: usize) -> Option<usize> {
        let mut max_r = -1;
        let mut ret: Option<usize> = None;
        let mut e = Some(quad_start);
        let mut guard = 0;
        while let Some(x) = e {
            let r = self.g.nodes[self.g.edges[x].to].dist;
            if r > max_r {
                max_r = r;
                ret = Some(x);
            }
            e = self.g.edges[x].next;
            guard += 1;
            if guard > 100_000 {
                break;
            }
        }
        let r = ret?;
        if self.g.edges[r].next.is_none()
            && self.g.nodes[self.g.edges[r].to].dist - nm(0.005) < self.g.nodes[self.g.edges[r].from].dist
        {
            return self.g.edges[r].prev;
        }
        Some(r)
    }

    fn propagate_upward(&mut self, upward: &[usize]) {
        for &e in upward.iter().rev() {
            let (from, to) = (self.g.edges[e].from, self.g.edges[e].to);
            if self.g.nodes[to].bead_count >= 0 {
                continue;
            }
            let Some(lower) = self.g.nodes[from].beading else {
                continue;
            };
            if self.g.nodes[to].beading.is_some() {
                continue;
            }
            let length = self.g.edge_len(e);
            let mut upper = self.beadings[lower].clone();
            upper.dist_to_bottom_source += length;
            upper.is_upward_propagated_only = true;
            self.beadings.push(upper);
            self.g.nodes[to].beading = Some(self.beadings.len() - 1);
        }
    }

    fn propagate_downward(&mut self, upward: &[usize]) {
        for &e in upward {
            if self.g.is_central(e) {
                continue;
            }
            let (from, to) = (self.g.edges[e].from, self.g.edges[e].to);
            if self.g.nodes[from].dist == self.g.nodes[to].dist
                && self.g.nodes[from].beading.is_some()
                && self.g.nodes[to].beading.is_none()
            {
                if let Some(t) = self.g.edges[e].twin {
                    self.propagate_downward_edge(t);
                }
            } else {
                self.propagate_downward_edge(e);
            }
        }
    }

    fn propagate_downward_edge(&mut self, edge_to_peak: usize) {
        let length = self.g.edge_len(edge_to_peak);
        let (from, to) = (self.g.edges[edge_to_peak].from, self.g.edges[edge_to_peak].to);
        let Some(top_i) = self.get_or_create_beading(to) else {
            return;
        };
        if self.g.nodes[from].beading.is_none() {
            let mut p = self.beadings[top_i].clone();
            p.dist_from_top_source += length;
            self.beadings.push(p);
            self.g.nodes[from].beading = Some(self.beadings.len() - 1);
        } else if let Some(bottom_i) = self.g.nodes[from].beading {
            let bottom_dist = self.beadings[bottom_i].dist_to_bottom_source;
            let total = self.beadings[top_i].dist_from_top_source + length + bottom_dist;
            #[allow(clippy::cast_precision_loss, reason = "lengths in nm")]
            let ratio_of_top =
                (bottom_dist as f64 / total.min(self.st.propagation_transition_dist).max(1) as f64).max(0.0);
            if ratio_of_top >= 1.0 {
                let mut p = self.beadings[top_i].clone();
                p.dist_from_top_source += length;
                self.beadings[bottom_i] = p;
            } else {
                let merged = interpolate_switching(
                    &self.beadings[top_i].beading,
                    ratio_of_top,
                    &self.beadings[bottom_i].beading,
                    self.g.nodes[from].dist,
                );
                self.beadings[bottom_i] = BeadingProp::new(merged);
            }
        }
    }

    /// The beading at a node, made from its bead count when it has none yet.
    fn get_or_create_beading(&mut self, node: usize) -> Option<usize> {
        if let Some(b) = self.g.nodes[node].beading {
            return Some(b);
        }
        if self.g.nodes[node].bead_count == -1 {
            if let Some(near) = self.nearest_beading(node, nm(0.1)) {
                return Some(near);
            }
            let mut d = i64::MAX;
            if let Some(start) = self.g.nodes[node].incident_edge {
                let mut e = start;
                let mut guard = 0;
                loop {
                    let to = self.g.edges[e].to;
                    d = d.min(self.g.nodes[to].dist + self.g.edge_len(e));
                    match self.g.rot_next(e) {
                        Some(nx) if nx != start && guard < 10_000 => e = nx,
                        _ => break,
                    }
                    guard += 1;
                }
            }
            if d == i64::MAX {
                return None;
            }
            self.g.nodes[node].bead_count = self.strat.optimal_bead_count(d * 2);
        }
        let b = self
            .strat
            .compute(self.g.nodes[node].dist * 2, self.g.nodes[node].bead_count);
        self.beadings.push(BeadingProp::new(b));
        self.g.nodes[node].beading = Some(self.beadings.len() - 1);
        self.g.nodes[node].beading
    }

    /// The beading of the closest node that has one, within `max_dist` along the graph.
    fn nearest_beading(&self, node: usize, max_dist: i64) -> Option<usize> {
        let mut heap: std::collections::BinaryHeap<std::cmp::Reverse<(i64, usize)>> =
            std::collections::BinaryHeap::new();
        let start = self.g.nodes[node].incident_edge?;
        let mut e = start;
        let mut guard = 0;
        loop {
            heap.push(std::cmp::Reverse((self.g.edge_len(e), e)));
            match self.g.rot_next(e) {
                Some(nx) if nx != start && guard < 10_000 => e = nx,
                _ => break,
            }
            guard += 1;
        }
        for _ in 0..1000 {
            let std::cmp::Reverse((d, e)) = heap.pop()?;
            if d > max_dist {
                return None;
            }
            let to = self.g.edges[e].to;
            if let Some(b) = self.g.nodes[to].beading {
                return Some(b);
            }
            let twin = self.g.edges[e].twin;
            let mut f = self.g.edges[e].next;
            let mut guard = 0;
            while let Some(x) = f {
                if Some(x) == twin || guard > 10_000 {
                    break;
                }
                heap.push(std::cmp::Reverse((d + self.g.edge_len(x), x)));
                f = self.g.rot_next(x);
                guard += 1;
            }
        }
        None
    }

    /// The junctions of each upward edge, from the high end down, where the beads cross it.
    fn generate_junctions(&mut self) {
        for e in self.g.live_edges() {
            let (from, to) = (self.g.edges[e].from, self.g.edges[e].to);
            if self.g.nodes[from].dist > self.g.nodes[to].dist {
                continue;
            }
            let start_r = self.g.nodes[to].dist;
            let end_r = self.g.nodes[from].dist;
            if (self.g.nodes[from].bead_count == self.g.nodes[to].bead_count
                && self.g.nodes[from].bead_count >= 0)
                || end_r >= start_r
            {
                continue;
            }
            let Some(bi) = self.get_or_create_beading(to) else {
                continue;
            };
            let beading = &self.beadings[bi].beading;
            let a = self.g.nodes[to].p;
            let b = self.g.nodes[from].p;
            let ab = b.minus(a);
            let num = beading.toolpath_locations.len();
            let mut ret: Vec<Junction> = Vec::new();
            // Start at the middle bead and go outward until a bead sits at or beyond the start node.
            let mut idx: i64 = i64::try_from((num.max(1) - 1) / 2).unwrap_or(0);
            while idx >= 0 && (idx as usize) < num {
                if beading.toolpath_locations[idx as usize] <= start_r + 1 {
                    break;
                }
                idx -= 1;
            }
            if ((idx + 1) as usize) < num
                && beading.toolpath_locations[(idx + 1) as usize] <= start_r + nm(0.005)
                && beading.total_thickness < start_r + nm(0.005)
            {
                idx += 1;
            }
            while idx >= 0 && (idx as usize) < num {
                let bead_r = beading.toolpath_locations[idx as usize];
                if bead_r < end_r {
                    break;
                }
                let mut junction = P::new(
                    a.x + ab.x * (bead_r - start_r) / (end_r - start_r),
                    a.y + ab.y * (bead_r - start_r) / (end_r - start_r),
                );
                if bead_r > start_r - nm(0.005) {
                    junction = a;
                }
                ret.push(Junction {
                    p: junction,
                    w: beading.bead_widths[idx as usize],
                    perimeter_index: idx as usize,
                });
                idx -= 1;
            }
            self.g.edges[e].junctions = Some(ret);
        }
    }

    #[allow(
        clippy::fn_params_excessive_bools,
        reason = "the two kinds of line and the two 3-way ends of a segment"
    )]
    fn add_segment(
        &mut self,
        from: Junction,
        to: Junction,
        is_odd: bool,
        force_new: bool,
        from_3way: bool,
        to_3way: bool,
    ) {
        if from == to {
            return;
        }
        let inset = from.perimeter_index;
        if self.out.len() <= inset {
            self.out.resize_with(inset + 1, Vec::new);
        }
        let lines = &mut self.out[inset];
        let mut force_new = force_new;
        if lines.last().is_none_or(|l| {
            l.is_odd != is_odd || l.junctions.last().is_none_or(|j| j.perimeter_index != inset)
        }) {
            force_new = true;
        }
        let tol = nm(0.010);
        if !force_new
            && let Some(last) = lines.last_mut()
            && let Some(lj) = last.junctions.last().copied()
            && short(lj.p.minus(from.p), tol)
            && (lj.w - from.w).abs() < tol
            && !from_3way
        {
            last.junctions.push(to);
        } else if !force_new
            && let Some(last) = lines.last_mut()
            && let Some(lj) = last.junctions.last().copied()
            && short(lj.p.minus(to.p), tol)
            && (lj.w - to.w).abs() < tol
            && !to_3way
        {
            last.junctions.push(from);
        } else {
            lines.push(Line {
                inset_idx: inset,
                is_odd,
                is_closed: false,
                junctions: vec![from, to],
            });
        }
    }

    /// Joins the junctions across each quad into wall lines.
    fn connect_junctions(&mut self) {
        // The quad starts still to walk, lowest id first; none are added once the walk begins.
        let mut unprocessed = vec![false; self.g.edges.len()];
        for e in self.g.live_edges() {
            if self.g.edges[e].prev.is_none() {
                unprocessed[e] = true;
            }
        }
        let mut lowest = 0;
        let mut passed_odd = vec![false; self.g.edges.len()];
        // Junction lists of the quad being joined, reused from quad to quad.
        let (mut from_junctions, mut to_junctions): (Vec<Junction>, Vec<Junction>) = (Vec::new(), Vec::new());
        loop {
            while lowest < unprocessed.len() && !unprocessed[lowest] {
                lowest += 1;
            }
            if lowest == unprocessed.len() {
                break;
            }
            let domain_start = lowest;
            let mut quad_start = domain_start;
            let mut new_domain = true;
            let mut guard = 0;
            loop {
                guard += 1;
                if guard > 1_000_000 {
                    break;
                }
                let mut quad_end = quad_start;
                while let Some(n) = self.g.edges[quad_end].next {
                    quad_end = n;
                }
                let Some(edge_to_peak) = self.quad_max_r_edge_to(quad_start) else {
                    unprocessed[quad_start] = false;
                    match self.g.next_unconnected(quad_start) {
                        Some(n) if n != domain_start => {
                            quad_start = n;
                            continue;
                        }
                        _ => break,
                    }
                };
                let Some(edge_from_peak) = self.g.edges[edge_to_peak].next else {
                    unprocessed[quad_start] = false;
                    break;
                };
                unprocessed[quad_start] = false;
                let Some(twin_from_peak) = self.g.edges[edge_from_peak].twin else {
                    break;
                };
                from_junctions.clear();
                from_junctions
                    .extend_from_slice(self.g.edges[edge_to_peak].junctions.get_or_insert_with(Vec::new));
                to_junctions.clear();
                to_junctions.extend_from_slice(
                    self.g.edges[twin_from_peak]
                        .junctions
                        .get_or_insert_with(Vec::new),
                );
                if let Some(prev) = self.g.edges[edge_to_peak].prev {
                    let from_prev = self.g.edges[prev].junctions.as_deref().unwrap_or_default();
                    while let (Some(last), Some(first)) = (from_junctions.last(), from_prev.first()) {
                        if last.perimeter_index <= first.perimeter_index {
                            from_junctions.pop();
                        } else {
                            break;
                        }
                    }
                    from_junctions.extend_from_slice(from_prev);
                }
                if let Some(next) = self.g.edges[edge_from_peak].next
                    && let Some(tw) = self.g.edges[next].twin
                {
                    let to_next = self.g.edges[tw].junctions.as_deref().unwrap_or_default();
                    while let (Some(last), Some(first)) = (to_junctions.last(), to_next.first()) {
                        if last.perimeter_index <= first.perimeter_index {
                            to_junctions.pop();
                        } else {
                            break;
                        }
                    }
                    to_junctions.extend_from_slice(to_next);
                }
                let segment_count = from_junctions.len().min(to_junctions.len());
                let qs_to = self.g.edges[quad_start].to;
                let qe_from = self.g.edges[quad_end].from;
                for rev in 0..segment_count {
                    let from = from_junctions[from_junctions.len() - 1 - rev];
                    let to = to_junctions[to_junctions.len() - 1 - rev];
                    let single_start = self.g.nodes[qs_to].bead_count > 0
                        && self.g.nodes[qs_to].bead_count % 2 == 1
                        && self.g.nodes[qs_to].transition_ratio == 0.0
                        && rev == segment_count - 1
                        && short(from.p.minus(self.g.nodes[qs_to].p), nm(0.005));
                    let single_end = self.g.nodes[qe_from].bead_count > 0
                        && self.g.nodes[qe_from].bead_count % 2 == 1
                        && self.g.nodes[qe_from].transition_ratio == 0.0
                        && rev == segment_count - 1
                        && short(to.p.minus(self.g.nodes[qe_from].p), nm(0.005));
                    let is_odd_segment = single_start && single_end;
                    let qs_next_twin = self.g.edges[quad_start].next.and_then(|n| self.g.edges[n].twin);
                    if is_odd_segment && qs_next_twin.is_some_and(|t| passed_odd[t]) {
                        continue;
                    }
                    let from_3way = single_start && self.g.is_multi_intersection(qs_to);
                    let to_3way = single_end && self.g.is_multi_intersection(qe_from);
                    if let Some(n) = self.g.edges[quad_start].next {
                        passed_odd[n] = true;
                    }
                    self.add_segment(from, to, is_odd_segment, new_domain, from_3way, to_3way);
                }
                new_domain = false;
                match self.g.next_unconnected(quad_start) {
                    Some(n) if n != domain_start => quad_start = n,
                    _ => break,
                }
            }
        }
    }

    /// A small round line at each local maximum where a single bead would be left.
    fn generate_local_maxima_single_beads(&mut self) {
        for n in self.g.live_nodes() {
            let Some(bi) = self.g.nodes[n].beading else {
                continue;
            };
            let beading = &self.beadings[bi].beading;
            if beading.bead_widths.len() % 2 == 1
                && self.g.is_local_maximum(n, true)
                && !self.g.node_is_central(n)
            {
                let inset = beading.bead_widths.len() / 2;
                let width = beading.bead_widths[inset];
                let r = width / 8;
                let p = self.g.nodes[n].p;
                if self.out.len() <= inset {
                    self.out.resize_with(inset + 1, Vec::new);
                }
                let mut line = Line {
                    inset_idx: inset,
                    is_odd: true,
                    is_closed: false,
                    junctions: Vec::new(),
                };
                for s in 0..6 {
                    let a = std::f64::consts::TAU / 6.0 * f64::from(s);
                    #[allow(
                        clippy::cast_possible_truncation,
                        clippy::cast_precision_loss,
                        reason = "lengths in nm"
                    )]
                    let (dx, dy) = ((r as f64 * a.m_cos()) as i64, (r as f64 * a.m_sin()) as i64);
                    line.junctions.push(Junction {
                        p: P::new(p.x + dx, p.y + dy),
                        w: width,
                        perimeter_index: inset,
                    });
                }
                self.out[inset].push(line);
            }
        }
    }
}

fn short(v: P, len: i64) -> bool {
    if v.x.abs() > len || v.y.abs() > len {
        return false;
    }
    v.dot(v) < len * len
}

/// `ab` scaled to length `len`.
fn normal(ab: P, len: i64) -> P {
    let l = ab.len();
    if l < 1 {
        return P::new(len, 0);
    }
    P::new(ab.x * len / l, ab.y * len / l)
}

/// A beading between two with the same bead count: widths and positions blend by `ratio_left`.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "widths in nm"
)]
fn interpolate(left: &Beading, ratio_left: f64, right: &Beading) -> Beading {
    let ratio_right = 1.0 - ratio_left;
    let mut ret = if left.total_thickness > right.total_thickness {
        left.clone()
    } else {
        right.clone()
    };
    for i in 0..left.bead_widths.len().min(right.bead_widths.len()) {
        ret.bead_widths[i] = if left.bead_widths[i] == 0 || right.bead_widths[i] == 0 {
            0
        } else {
            (ratio_left * left.bead_widths[i] as f64 + ratio_right * right.bead_widths[i] as f64) as i64
        };
        ret.toolpath_locations[i] = (ratio_left * left.toolpath_locations[i] as f64
            + ratio_right * right.toolpath_locations[i] as f64) as i64;
    }
    ret
}

/// [`interpolate`], then a correction when one inset would land on the wrong side of the radius the
/// beadings switch at.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "widths in nm"
)]
fn interpolate_switching(left: &Beading, ratio_left: f64, right: &Beading, switching_radius: i64) -> Beading {
    let ret = interpolate(left, ratio_left, right);
    let locs = &left.toolpath_locations;
    let mut next_inset: i64 = i64::try_from(locs.len()).unwrap_or(0) - 1;
    while next_inset >= 0 {
        if switching_radius > locs[next_inset as usize] {
            break;
        }
        next_inset -= 1;
    }
    if next_inset < 0 || (next_inset + 1) as usize == locs.len() {
        return ret;
    }
    let i = next_inset as usize;
    if ret
        .toolpath_locations
        .get(i)
        .is_some_and(|l| *l > switching_radius)
    {
        let (Some(r), Some(l)) = (right.toolpath_locations.get(i), left.toolpath_locations.get(i)) else {
            return ret;
        };
        if l == r {
            return ret;
        }
        let new_ratio = ((switching_radius - r) as f64 / (l - r) as f64 + 0.1).min(1.0);
        return interpolate(left, new_ratio, right);
    }
    ret
}

/// A stable merge sort that tolerates a comparison that is not a strict weak order (the order the
/// upward edges are sorted in has ties it only partly resolves), where `sort_by` may panic.
fn stable_sort_by(v: &mut Vec<usize>, cmp: &dyn Fn(usize, usize) -> std::cmp::Ordering) {
    if v.len() < 2 {
        return;
    }
    let mut right = v.split_off(v.len() / 2);
    stable_sort_by(v, cmp);
    stable_sort_by(&mut right, cmp);
    let left = std::mem::take(v);
    let (mut i, mut j) = (0, 0);
    while i < left.len() && j < right.len() {
        if cmp(right[j], left[i]) == std::cmp::Ordering::Less {
            v.push(right[j]);
            j += 1;
        } else {
            v.push(left[i]);
            i += 1;
        }
    }
    v.extend_from_slice(&left[i..]);
    v.extend_from_slice(&right[j..]);
}
