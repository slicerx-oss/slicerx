// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Drawing organic trees, as Orca's `organic_draw_branches` (Support/TreeSupport3D.cpp):
//!
//! 1. The branch points are smoothed (`organic_smooth_branches_avoid_collisions`): each point is a sphere of
//!    the branch radius, nudged out of the object's collision lines of the layers it spans and pulled toward
//!    the average of its neighbors, in up to 100 rounds, never further from a linked point than the branch may
//!    lean.
//! 2. The trees are split into branches between forks, and each branch becomes a tube mesh: circles around the
//!    points at right angles to the branch, joined into triangle strips, with half spheres at the ends (a flat
//!    foot on the bed).
//! 3. Each tube is sliced half way through every layer, kept clear of the object and the bed edge; branches that
//!    rest on the object get a bottom contact, and those that hang get extended down onto the next surface.
//!    Roofs that tips could not place earlier are taken from the slices of their branch.
//! 4. The slices of all trees are united per layer, smoothed outward and simplified; the top contacts and bottom
//!    contacts are taken out of the base.

#![allow(
    clippy::manual_midpoint,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    reason = "ports of Orca's long functions over layer arrays; plate units in i64 and mesh coordinates in mm"
)]

use super::elements::{self, Element};
use super::geo::{self, Pt, Ring};
use super::settings::Settings;
use super::volumes::Volumes;
use super::{Params, Placer};
use crate::fm::Fm as _;
use crate::perimeters::{self, Shapes};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::i_float::int::point::IntPoint;
use std::collections::HashMap;

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn mul(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn norm(a: V3) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}
fn normalized(a: V3) -> V3 {
    let n = norm(a);
    if n == 0.0 { a } else { mul(a, 1.0 / n) }
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn d2(a: V3, b: V3) -> f64 {
    let d = sub(a, b);
    d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
}

/// The Z of support layer `idx` as Orca's organic trees take it (`layer_z`): the raft layers, then the first
/// object layer and steps of the layer height.
pub(crate) struct Heights {
    pub(crate) raft: Vec<f64>,
    pub(crate) first: f64,
    pub(crate) layer: f64,
}

impl Heights {
    pub(crate) fn z(&self, idx: i64) -> f64 {
        let r = self.raft.len() as i64;
        if idx < r {
            return self.raft.get(idx.max(0) as usize).copied().unwrap_or(0.0);
        }
        self.first + (idx - r) as f64 * self.layer
    }
    /// `layer_idx_ceil`: the lowest layer at or above `z`.
    fn idx_ceil(&self, z: f64) -> i64 {
        if !self.raft.is_empty() && z < self.first - 1e-4 {
            return self.raft.partition_point(|&t| t < z - 1e-4) as i64;
        }
        self.raft.len() as i64 + 0.max(((z - self.first) / self.layer).ceil() as i64)
    }
    /// `layer_idx_floor`: the highest layer at or below `z`.
    fn idx_floor(&self, z: f64) -> i64 {
        if !self.raft.is_empty() && z < self.first - 1e-4 {
            let i = self.raft.partition_point(|&t| t <= z + 1e-4);
            return (i as i64 - 1).max(0);
        }
        self.raft.len() as i64 + 0.max(((z - self.first) / self.layer).floor() as i64)
    }
}

/// The union of `rings`, each half first. A tree's branches overlap heavily where they meet, so uniting
/// neighbors first drops their inner edges before the next union has to split them; the area is the same as
/// one union of all, up to where crossings round to the plate grid.
fn union_halves(rings: &[Ring]) -> Shapes {
    const LEAF: usize = 8;
    if rings.len() <= LEAF {
        return geo::merge_rings(rings, FillRule::NonZero);
    }
    let mid = rings.len() / 2;
    geo::union2(&union_halves(&rings[..mid]), &union_halves(&rings[mid..]))
}

/// Whether the box `a` lies strictly inside `b` (an empty `a` does; no `b` holds nothing).
fn inside_box(a: Option<[i32; 4]>, b: Option<[i32; 4]>) -> bool {
    match (a, b) {
        (None, _) => true,
        (Some(a), Some(b)) => a[0] > b[0] && a[1] > b[1] && a[2] < b[2] && a[3] < b[3],
        (Some(_), None) => false,
    }
}

fn unscale(v: i64) -> f64 {
    v as f64 / crate::geom::SCALE
}

/// Collision lines of one layer in a grid for nearest-point queries within a radius.
struct LineGrid {
    lines: Vec<([f64; 2], [f64; 2])>,
    cell: f64,
    origin: [f64; 2],
    cols: usize,
    rows: usize,
    /// The lines of cell `k` are `items[starts[k]..starts[k + 1]]`, in line order.
    starts: Vec<u32>,
    items: Vec<u32>,
    /// Summed line counts over the cells, `(cols + 1) * (rows + 1)`, so a query over empty cells ends at once.
    sums: Vec<u32>,
}

impl LineGrid {
    fn new(lines: Vec<([f64; 2], [f64; 2])>) -> Option<Self> {
        if lines.is_empty() {
            return None;
        }
        let mut lo = [f64::MAX; 2];
        let mut hi = [f64::MIN; 2];
        for (a, b) in &lines {
            for p in [a, b] {
                lo = [lo[0].min(p[0]), lo[1].min(p[1])];
                hi = [hi[0].max(p[0]), hi[1].max(p[1])];
            }
        }
        let cell = 1.0;
        let cols = (((hi[0] - lo[0]) / cell).floor() as usize + 1).min(4096);
        let rows = (((hi[1] - lo[1]) / cell).floor() as usize + 1).min(4096);
        let span = |a: &[f64; 2], b: &[f64; 2]| {
            let c0 = (((a[0].min(b[0]) - lo[0]) / cell).floor() as usize).min(cols - 1);
            let c1 = (((a[0].max(b[0]) - lo[0]) / cell).floor() as usize).min(cols - 1);
            let r0 = (((a[1].min(b[1]) - lo[1]) / cell).floor() as usize).min(rows - 1);
            let r1 = (((a[1].max(b[1]) - lo[1]) / cell).floor() as usize).min(rows - 1);
            (c0, c1, r0, r1)
        };
        // Counted first, then filled in line order, so each cell's lines are one run of `items`.
        let mut starts = vec![0u32; cols * rows + 1];
        for (a, b) in &lines {
            let (c0, c1, r0, r1) = span(a, b);
            for r in r0..=r1 {
                for c in c0..=c1 {
                    starts[r * cols + c + 1] += 1;
                }
            }
        }
        for k in 0..cols * rows {
            starts[k + 1] += starts[k];
        }
        let mut fill = starts.clone();
        let mut items = vec![0u32; starts[cols * rows] as usize];
        for (i, (a, b)) in lines.iter().enumerate() {
            let (c0, c1, r0, r1) = span(a, b);
            for r in r0..=r1 {
                for c in c0..=c1 {
                    let at = &mut fill[r * cols + c];
                    items[*at as usize] = i as u32;
                    *at += 1;
                }
            }
        }
        drop(fill);
        let w = cols + 1;
        let mut sums = vec![0u32; w * (rows + 1)];
        for r in 0..rows {
            for c in 0..cols {
                let k = r * cols + c;
                sums[(r + 1) * w + c + 1] =
                    (starts[k + 1] - starts[k]) + sums[r * w + c + 1] + sums[(r + 1) * w + c]
                        - sums[r * w + c];
            }
        }
        Some(Self {
            lines,
            cell,
            origin: lo,
            cols,
            rows,
            starts,
            items,
            sums,
        })
    }

    /// The closest point on a line within `sqrt(max_d2)` of `p`, and its squared distance; `max_d2` when none.
    fn closest(&self, p: [f64; 2], max_d2: f64) -> (f64, Option<[f64; 2]>) {
        let r = max_d2.sqrt();
        let cx0 = ((p[0] - r - self.origin[0]) / self.cell).floor();
        let cx1 = ((p[0] + r - self.origin[0]) / self.cell).floor();
        let cy0 = ((p[1] - r - self.origin[1]) / self.cell).floor();
        let cy1 = ((p[1] + r - self.origin[1]) / self.cell).floor();
        if cx1 < 0.0 || cy1 < 0.0 || cx0 >= self.cols as f64 || cy0 >= self.rows as f64 {
            return (max_d2, None);
        }
        let (c0, c1) = (cx0.max(0.0) as usize, (cx1 as usize).min(self.cols - 1));
        let (r0, r1) = (cy0.max(0.0) as usize, (cy1 as usize).min(self.rows - 1));
        let w = self.cols + 1;
        let count = self.sums[(r1 + 1) * w + c1 + 1] + self.sums[r0 * w + c0]
            - self.sums[r0 * w + c1 + 1]
            - self.sums[(r1 + 1) * w + c0];
        if count == 0 {
            return (max_d2, None);
        }
        let mut best = max_d2;
        let mut hit = None;
        let mut best_idx = u32::MAX;
        for row in r0..=r1 {
            for col in c0..=c1 {
                let k = row * self.cols + col;
                for &i in &self.items[self.starts[k] as usize..self.starts[k + 1] as usize] {
                    let (a, b) = self.lines[i as usize];
                    let v = [b[0] - a[0], b[1] - a[1]];
                    let w = [p[0] - a[0], p[1] - a[1]];
                    let l2 = v[0] * v[0] + v[1] * v[1];
                    let t = if l2 > 0.0 {
                        ((w[0] * v[0] + w[1] * v[1]) / l2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let q = [a[0] + v[0] * t, a[1] + v[1] * t];
                    let dd = (q[0] - p[0]).m_powi(2) + (q[1] - p[1]).m_powi(2);
                    #[allow(
                        clippy::float_cmp,
                        reason = "an exact tie between two distances goes to the lower index"
                    )]
                    let tie = dd == best;
                    if dd < best || (tie && hit.is_some() && i < best_idx) {
                        best = dd;
                        hit = Some(q);
                        best_idx = i;
                    }
                }
            }
        }
        (best, hit)
    }
}

/// A branch point while smoothing: a sphere of the branch radius around it.
struct Sphere {
    layer: usize,
    below: i32,
    parents: Vec<i32>,
    locked: bool,
    radius: f64,
    elem_radius: i64,
    position: [f64; 3],
    prev: [f64; 3],
    min_z: f64,
    max_z: f64,
    layer_begin: usize,
    layer_end: usize,
}

/// `organic_smooth_branches_avoid_collisions` (the version with per layer line trees).
fn smooth_branches(
    volumes: &Volumes,
    cfg: &Settings,
    h: &Heights,
    move_bounds: &mut [Vec<Element>],
    links: &[(usize, usize, i32)],
    offsets: &[usize],
) {
    const EXTRA_GAP: f64 = 0.1;
    const MAX_NUDGE_COLLISION: f64 = 0.5;
    const MAX_NUDGE_SMOOTHING: f64 = 0.2;
    let num_cache_layers = links.iter().map(|&(l, _, _)| l + 1).max().unwrap_or(0);
    let mut has_element = vec![false; num_cache_layers];
    for &(l, _, _) in links {
        has_element[l] = true;
    }
    let grids: Vec<Option<LineGrid>> = crate::par::map_range(0..num_cache_layers as u32, |l| {
        if !has_element[l as usize] {
            return None;
        }
        let (_, area) = volumes.collision_lower_bound(i64::from(l), 0)?;
        let mut lines = Vec::new();
        for r in geo::rings(&area) {
            let n = r.len();
            for i in 0..n {
                let a = r[i];
                let b = r[(i + 1) % n];
                lines.push((
                    [
                        f64::from(a.x) / crate::geom::SCALE,
                        f64::from(a.y) / crate::geom::SCALE,
                    ],
                    [
                        f64::from(b.x) / crate::geom::SCALE,
                        f64::from(b.y) / crate::geom::SCALE,
                    ],
                ));
            }
        }
        LineGrid::new(lines)
    });

    let mut spheres: Vec<Sphere> = Vec::with_capacity(links.len());
    for &(l, i, below) in links {
        let e = &move_bounds[l][i];
        let r = elements::radius(cfg, &e.state);
        let p = e.state.result_on_layer.unwrap_or((0, 0));
        let z = h.z(l as i64);
        let min_z = if below == -1 {
            z
        } else {
            spheres[offsets[l - 1] + below as usize].min_z
        };
        spheres.push(Sphere {
            layer: l,
            below,
            parents: e.parents.clone(),
            locked: e.parents.is_empty() || (below == -1 && l > 0),
            radius: unscale(r),
            elem_radius: r,
            position: [unscale(p.0), unscale(p.1), z],
            prev: [0.0; 3],
            min_z,
            max_z: f64::MAX,
            layer_begin: 0,
            layer_end: 0,
        });
    }
    for id in (0..spheres.len()).rev() {
        if spheres[id].parents.is_empty() {
            spheres[id].max_z = spheres[id].position[2];
        } else {
            let above = offsets[spheres[id].layer + 1];
            let mut m = spheres[id].max_z;
            for &p in &spheres[id].parents {
                m = m.min(spheres[above + p as usize].max_z);
            }
            spheres[id].max_z = m;
        }
    }
    for s in &mut spheres {
        s.min_z = s.min_z.max(s.position[2] - s.radius);
        s.max_z = s.max_z.min(s.position[2] + s.radius);
        s.layer_begin = s.layer.min(h.idx_ceil(s.min_z) as usize);
        s.layer_end = num_cache_layers.min(s.layer.max(h.idx_floor(s.max_z) as usize) + 1);
    }

    let slow = unscale(cfg.maximum_move_distance_slow);
    for _ in 0..100 {
        for s in &mut spheres {
            s.prev = s.position;
        }
        let snapshot: Vec<([f64; 3], i64)> = spheres.iter().map(|s| (s.prev, s.elem_radius)).collect();
        let limit = |id: usize,
                     layer: usize,
                     below: i32,
                     parents: &[i32],
                     current: [f64; 2],
                     radius: i64,
                     mut cand: [f64; 2]|
         -> [f64; 2] {
            let constrain = |cand: [f64; 2], anchor: [f64; 2], allowed: f64| -> [f64; 2] {
                let delta = [cand[0] - anchor[0], cand[1] - anchor[1]];
                let cd = delta[0].m_hypot(delta[1]);
                let cur = (current[0] - anchor[0]).m_hypot(current[1] - anchor[1]);
                let allowed = allowed.max(cur);
                if cd > allowed && cd > 1e-4 {
                    [
                        anchor[0] + delta[0] * allowed / cd,
                        anchor[1] + delta[1] * allowed / cd,
                    ]
                } else {
                    cand
                }
            };
            let _ = id;
            if below != -1 && layer > 0 {
                let lid = offsets[layer - 1] + below as usize;
                if let Some(&(lp, lr)) = snapshot.get(lid) {
                    let allowed = unscale((lr - radius).max(0)) + slow;
                    cand = constrain(cand, [lp[0], lp[1]], allowed);
                }
            }
            if !parents.is_empty() && layer + 1 < offsets.len() - 1 {
                let up = offsets[layer + 1];
                for &p in parents {
                    if let Some(&(pp, pr)) = snapshot.get(up + p as usize) {
                        let allowed = unscale((radius - pr).max(0)) + slow;
                        cand = constrain(cand, [pp[0], pp[1]], allowed);
                    }
                }
            }
            cand
        };
        let moved: Vec<(Option<[f64; 2]>, bool)> = crate::par::map_range(0..spheres.len() as u32, |id| {
            let id = id as usize;
            let s = &spheres[id];
            if s.locked {
                return (None, false);
            }
            let mut pos = [s.position[0], s.position[1]];
            let mut depth = -f64::MAX;
            let mut last: [f64; 2] = [0.0, 0.0];
            for layer_id in s.layer_begin..s.layer_end {
                let dz = (layer_id as f64 - s.layer as f64) * h.layer;
                let r2 = s.radius * s.radius - dz * dz;
                if r2 > 0.0
                    && let Some(Some(g)) = grids.get(layer_id)
                {
                    let (dd, hit) = g.closest(pos, r2);
                    let dist = dd.sqrt();
                    let cdepth = r2.sqrt() - dist;
                    if cdepth > depth {
                        depth = cdepth;
                        if let Some(q) = hit {
                            last = q;
                        }
                    }
                }
            }
            let mut counted = false;
            if depth > 0.0 {
                if depth > 1e-4 {
                    counted = true;
                }
                let nudge = (depth + EXTRA_GAP).clamp(0.0, MAX_NUDGE_COLLISION);
                let dir = [pos[0] - last[0], pos[1] - last[1]];
                let dl = dir[0].m_hypot(dir[1]);
                // Out of the collision by the nudge distance (Orca scales its nudge vector by that distance a
                // second time, which moves a point 0.25 mm instead of 0.5 mm per round and leaves shallow
                // collisions in place).
                let cand = if dl > 0.0 {
                    [pos[0] + dir[0] / dl * nudge, pos[1] + dir[1] / dl * nudge]
                } else {
                    pos
                };
                pos = limit(id, s.layer, s.below, &s.parents, pos, s.elem_radius, cand);
            }
            // Laplacian smoothing toward the points above and below.
            let mut avg = [0.0, 0.0];
            let mut weight = 0.0;
            if !s.parents.is_empty() {
                let up = offsets[s.layer + 1];
                for &p in &s.parents {
                    let w = s.radius;
                    let q = snapshot[up + p as usize].0;
                    avg = [avg[0] + w * q[0], avg[1] + w * q[1]];
                    weight += w;
                }
            }
            if s.below != -1 {
                let q = snapshot[offsets[s.layer - 1] + s.below as usize].0;
                let w = weight;
                avg = [avg[0] + w * q[0], avg[1] + w * q[1]];
                weight += w;
            }
            avg = [avg[0] / weight, avg[1] / weight];
            let new_pos = [0.5 * pos[0] + 0.5 * avg[0], 0.5 * pos[1] + 0.5 * avg[1]];
            let shift = [new_pos[0] - pos[0], new_pos[1] - pos[1]];
            let max = shift[0].m_hypot(shift[1]);
            let nudge = max.clamp(0.0, MAX_NUDGE_SMOOTHING);
            if nudge > 0.0 {
                let cand = [
                    pos[0] + shift[0] * (nudge / max),
                    pos[1] + shift[1] * (nudge / max),
                ];
                pos = limit(id, s.layer, s.below, &s.parents, pos, s.elem_radius, cand);
            }
            (Some(pos), counted)
        });
        let mut num_moved = 0;
        for (s, (p, counted)) in spheres.iter_mut().zip(moved) {
            if let Some(p) = p {
                s.position[0] = p[0];
                s.position[1] = p[1];
            }
            if counted {
                num_moved += 1;
            }
        }
        if num_moved == 0 {
            break;
        }
    }
    for (s, &(l, i, _)) in spheres.iter().zip(links) {
        move_bounds[l][i].state.result_on_layer = Some((
            (s.position[0] * crate::geom::SCALE) as i64,
            (s.position[1] * crate::geom::SCALE) as i64,
        ));
    }
}

/// A triangle mesh in millimeters.
#[derive(Default)]
struct Mesh {
    v: Vec<V3>,
    t: Vec<[u32; 3]>,
}

impl Mesh {
    fn fan(&mut self, ifan: usize, begin: usize, end: usize, flip: bool) {
        let mut u = end - 1;
        for v in begin..end {
            if flip {
                self.t.push([ifan as u32, u as u32, v as u32]);
            } else {
                self.t.push([ifan as u32, v as u32, u as u32]);
            }
            u = v;
        }
    }

    /// `triangulate_strip`.
    fn strip(&mut self, b1: usize, e1: usize, b2: usize, e2: usize) {
        let (mut n1, mut n2) = (e1 - b1, e2 - b2);
        let p1 = self.v[b1];
        let mut start2 = b2;
        let mut best = f64::MAX;
        for i in b2..e2 {
            let d = d2(self.v[i], p1);
            if d < best {
                best = d;
                start2 = i;
            }
        }
        let (mut u, mut v) = (b1, start2);
        while n1 > 0 || n2 > 0 {
            let next_u = if u + 1 == e1 { b1 } else { u + 1 };
            let next_v = if v + 1 == e2 { b2 } else { v + 1 };
            let take_first = if n1 == 0 {
                false
            } else if n2 == 0 {
                true
            } else {
                d2(self.v[next_u], self.v[v]) < d2(self.v[next_v], self.v[u])
            };
            if take_first {
                self.t.push([u as u32, next_u as u32, v as u32]);
                n1 -= 1;
                u = next_u;
            } else {
                self.t.push([u as u32, next_v as u32, v as u32]);
                n2 -= 1;
                v = next_v;
            }
        }
    }

    /// `discretize_circle`.
    fn circle(&mut self, center: V3, normal: V3, radius: f64, eps: f64) -> (usize, usize) {
        let mut step = 2.0 * (1.0 - eps / radius).m_acos();
        let n = (std::f64::consts::TAU / step).ceil().max(3.0) as usize;
        step = std::f64::consts::TAU / n as f64;
        let x = normalized(cross(normal, [0.0, -1.0, 0.0]));
        let y = normalized(cross(normal, x));
        let (x, y) = (mul(x, radius), mul(y, radius));
        let begin = self.v.len();
        let mut a: f64 = 0.0;
        for _ in 0..n {
            self.v
                .push(add(center, add(mul(x, a.m_cos()), mul(y, a.m_sin()))));
            a += step;
        }
        (begin, self.v.len())
    }
}

/// `extrude_branch`: the tube around one branch path, returning its Z span.
fn extrude_branch(
    path: &[(usize, usize)],
    move_bounds: &[Vec<Element>],
    cfg: &Settings,
    h: &Heights,
    has_root: bool,
    m: &mut Mesh,
) -> (f64, f64) {
    const EPS: f64 = 0.015;
    let mut prev_strip = (0, 0);
    let mut zmin = 0.0;
    let mut zmax = 0.0;
    let at = |k: usize| -> (V3, f64, i64) {
        let (l, i) = path[k];
        let e = &move_bounds[l][i];
        let p = e.state.result_on_layer.unwrap_or((0, 0));
        (
            [unscale(p.0), unscale(p.1), h.z(e.state.layer_idx)],
            unscale(elements::radius(cfg, &e.state)),
            e.state.layer_idx,
        )
    };
    for ip in 1..path.len() {
        let (p1, r_prev, l_prev) = at(ip - 1);
        let (p2, r_cur, _) = at(ip);
        let v1 = normalized(sub(p2, p1));
        if ip == 1 {
            let nprev = v1;
            let radius = r_prev;
            if has_root && l_prev == 0 {
                // A flat foot on the bed.
                let normal = [0.0, 0.0, 1.0];
                let bottom = [p1[0], p1[1], 0.0];
                let ifan = m.v.len();
                m.v.push(bottom);
                let bs = m.circle(bottom, normal, radius, EPS);
                m.fan(ifan, bs.0, bs.1, false);
                prev_strip = m.circle(p1, normal, radius, EPS);
                m.strip(bs.0, bs.1, prev_strip.0, prev_strip.1);
                zmin = 0.0;
            } else {
                // The bottom half sphere.
                let mut step = 2.0 * (1.0 - EPS / radius).m_acos();
                let n = (std::f64::consts::PI / (2.0 * step)).ceil() as usize;
                step = std::f64::consts::PI / (2.0 * n as f64);
                let ifan = m.v.len();
                m.v.push(sub(p1, mul(nprev, radius)));
                zmin = m.v[ifan][2];
                let mut angle = step;
                for i in 1..n {
                    let s = m.circle(
                        sub(p1, mul(nprev, radius * angle.m_cos())),
                        nprev,
                        radius * angle.m_sin(),
                        EPS,
                    );
                    if i == 1 {
                        m.fan(ifan, s.0, s.1, false);
                    } else {
                        m.strip(prev_strip.0, prev_strip.1, s.0, s.1);
                    }
                    prev_strip = s;
                    angle += step;
                }
            }
        }
        if ip + 1 == path.len() {
            // The top half sphere.
            let ncur = v1;
            let radius = r_cur;
            let mut step = 2.0 * (1.0 - EPS / radius).m_acos();
            let n = (std::f64::consts::PI / (2.0 * step)).ceil() as usize;
            step = std::f64::consts::PI / (2.0 * n as f64);
            let mut angle = std::f64::consts::FRAC_PI_2;
            for _ in 0..n {
                let s = m.circle(
                    add(p2, mul(ncur, radius * angle.m_cos())),
                    ncur,
                    radius * angle.m_sin(),
                    EPS,
                );
                m.strip(prev_strip.0, prev_strip.1, s.0, s.1);
                prev_strip = s;
                angle -= step;
            }
            let ifan = m.v.len();
            m.v.push(add(p2, mul(ncur, radius)));
            zmax = m.v[ifan][2];
            m.fan(ifan, prev_strip.0, prev_strip.1, true);
        } else {
            let (p3, _, _) = at(ip + 1);
            let v2 = normalized(sub(p3, p2));
            let ncur = normalized(add(v1, v2));
            let s = m.circle(p2, ncur, r_cur, EPS);
            m.strip(prev_strip.0, prev_strip.1, s.0, s.1);
            prev_strip = s;
        }
    }
    (zmin, zmax)
}

/// The triangles of `m` each cut height in `zs` (ascending) crosses: those with a corner at or below it and one
/// above, in mesh order.
fn triangles_at(m: &Mesh, zs: &[f64]) -> Vec<Vec<u32>> {
    let mut out: Vec<Vec<u32>> = vec![Vec::new(); zs.len()];
    for (ti, t) in m.t.iter().enumerate() {
        let z = t.map(|i| m.v[i as usize][2]);
        let (lo, hi) = (z[0].min(z[1]).min(z[2]), z[0].max(z[1]).max(z[2]));
        let first = zs.partition_point(|&h| h < lo);
        let end = zs.partition_point(|&h| h < hi);
        for slot in &mut out[first..end] {
            slot.push(ti as u32);
        }
    }
    out
}

/// Cuts a closed mesh at `z`: the loops with the solid on their left, united with the positive fill rule.
/// `tris` are the triangles crossing `z` ([`triangles_at`]), in mesh order.
fn slice_mesh(m: &Mesh, z: f64, tris: &[u32]) -> Shapes {
    let key = |a: u32, b: u32| -> u64 { (u64::from(a.min(b)) << 32) | u64::from(a.max(b)) };
    let cut = |a: u32, b: u32| -> IntPoint<i32> {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        let (p, q) = (m.v[lo as usize], m.v[hi as usize]);
        let dz = q[2] - p[2];
        let t = if dz == 0.0 { 0.0 } else { (z - p[2]) / dz };
        IntPoint::new(
            ((p[0] + t * (q[0] - p[0])) * crate::geom::SCALE).round() as i32,
            ((p[1] + t * (q[1] - p[1])) * crate::geom::SCALE).round() as i32,
        )
    };
    // Each crossed edge going down leads to the edge going up in the same triangle; a later triangle with the same
    // down edge replaces an earlier one, as a map insert would.
    let mut next: Vec<(u64, u64, IntPoint<i32>)> = Vec::with_capacity(tris.len());
    for &ti in tris {
        let [i0, i1, i2] = m.t[ti as usize];
        let (a, b, c) = (
            m.v[i0 as usize][2] > z,
            m.v[i1 as usize][2] > z,
            m.v[i2 as usize][2] > z,
        );
        let mut down = None;
        let mut up = None;
        for (ea, eb, ia, ib) in [(a, b, i0, i1), (b, c, i1, i2), (c, a, i2, i0)] {
            if ea && !eb {
                down = Some((ia, ib));
            } else if !ea && eb {
                up = Some((ia, ib));
            }
        }
        let (Some(d), Some(u)) = (down, up) else { continue };
        next.push((key(d.0, d.1), key(u.0, u.1), cut(d.0, d.1)));
    }
    next.sort_by_key(|e| e.0);
    // Of equal keys the stable sort keeps insertion order; the last one is the one a map would hold.
    let mut uniq: Vec<(u64, u64, IntPoint<i32>)> = Vec::with_capacity(next.len());
    for e in next {
        match uniq.last_mut() {
            Some(l) if l.0 == e.0 => *l = e,
            _ => uniq.push(e),
        }
    }
    let mut used = vec![false; uniq.len()];
    let find = |k: u64| uniq.binary_search_by_key(&k, |e| e.0).ok();
    let mut rings: Vec<Ring> = Vec::new();
    for start in 0..uniq.len() {
        if used[start] {
            continue;
        }
        let k = uniq[start].0;
        let mut ring: Ring = Vec::new();
        let mut cur = k;
        while let Some(at) = find(cur).filter(|&at| !used[at]) {
            used[at] = true;
            ring.push(uniq[at].2);
            cur = uniq[at].1;
        }
        if cur == k && ring.len() >= 3 {
            rings.push(ring);
        }
    }
    geo::merge_rings(&rings, FillRule::Positive)
}

/// One branch: element positions `(layer, index)` from the bottom to the next fork or tip.
struct Branch {
    path: Vec<(usize, usize)>,
    has_root: bool,
    has_tip: bool,
}

#[derive(Default, Clone)]
struct Slice {
    polygons: Vec<Ring>,
    bottom_contacts: Vec<Ring>,
    num_branches: usize,
}

fn visit(move_bounds: &mut [Vec<Element>], start: (usize, usize), out: &mut Vec<Branch>) {
    move_bounds[start.0][start.1].state.marked = true;
    let root = out.is_empty();
    let parents = move_bounds[start.0][start.1].parents.clone();
    for &pi in &parents {
        let mut path = vec![start];
        let first = (start.0 + 1, pi as usize);
        path.push(first);
        let fp = move_bounds[first.0][first.1].parents.clone();
        if fp.len() < 2 {
            move_bounds[first.0][first.1].state.marked = true;
        }
        let mut next_branch: Option<(usize, usize)> = None;
        if fp.len() == 1 {
            let mut cur = first;
            loop {
                let np = (cur.0 + 1, move_bounds[cur.0][cur.1].parents[0] as usize);
                path.push(np);
                let npp = move_bounds[np.0][np.1].parents.len();
                if npp > 1 {
                    next_branch = Some(np);
                    break;
                }
                move_bounds[np.0][np.1].state.marked = true;
                if npp == 0 {
                    break;
                }
                cur = np;
            }
        } else if fp.len() > 1 {
            next_branch = Some(first);
        }
        out.push(Branch {
            path,
            has_root: root,
            has_tip: next_branch.is_none(),
        });
        if let Some(nb) = next_branch {
            visit(move_bounds, nb, out);
        }
    }
}

/// One tree's slices from its first layer, and the roofs recovered from its branches (rings, layer, depth).
type TreeResult = (i64, Vec<Slice>, Vec<(Vec<Ring>, i64, usize)>);

/// The areas `organic_draw_branches` hands on, per support layer.
#[derive(Default, Clone)]
pub(crate) struct Drawn {
    pub(crate) base: Vec<Shapes>,
    pub(crate) bottom_contacts: Vec<Shapes>,
}

/// `organic_draw_branches`.
pub(crate) fn draw_branches(
    volumes: &mut Volumes,
    cfg: &Settings,
    params: &Params,
    h: &Heights,
    move_bounds: &mut [Vec<Element>],
    placer: &mut Placer,
) -> Drawn {
    // Every element with the element below it that it rests on.
    let mut links: Vec<(usize, usize, i32)> = Vec::new();
    let mut offsets: Vec<usize> = vec![0];
    {
        let mut down_old: HashMap<usize, i32> = HashMap::new();
        for layer in 0..move_bounds.len() {
            let mut down_new: HashMap<usize, i32> = HashMap::new();
            for ei in 0..move_bounds[layer].len() {
                let child = if layer > 0 {
                    down_old.get(&ei).copied().unwrap_or(-1)
                } else {
                    -1
                };
                if layer + 1 < move_bounds.len() {
                    for &p in &move_bounds[layer][ei].parents {
                        if move_bounds[layer + 1]
                            .get(p as usize)
                            .is_some_and(|pe| pe.state.result_on_layer.is_some())
                        {
                            down_new.insert(p as usize, ei as i32);
                        }
                    }
                }
                links.push((layer, ei, child));
            }
            down_old = down_new;
            offsets.push(links.len());
        }
    }
    smooth_branches(volumes, cfg, h, move_bounds, &links, &offsets);
    volumes.clear_all_but_collision();
    for layer in move_bounds.iter_mut() {
        for e in layer.iter_mut() {
            e.state.marked = false;
        }
    }
    // Trees: each from an unvisited element that holds something up.
    let mut trees: Vec<Vec<Branch>> = Vec::new();
    for layer in 0..move_bounds.len().saturating_sub(1) {
        for ei in 0..move_bounds[layer].len() {
            let e = &move_bounds[layer][ei];
            if !e.state.marked && !e.parents.is_empty() {
                let mut branches = Vec::new();
                visit(move_bounds, (layer, ei), &mut branches);
                trees.push(branches);
            }
        }
    }
    let tiny = geo::tiny_area();
    let volumes = &*volumes;
    let move_bounds_ro: &[Vec<Element>] = move_bounds;
    // The bed is one rectangle; its box is the bed itself.
    let bed_box =
        if volumes.bed_area.len() == 1 && volumes.bed_area[0].len() == 1 && volumes.bed_area[0][0].len() == 4
        {
            perimeters::bounds(&volumes.bed_area)
        } else {
            None
        };
    // Each tree: its slices from its first layer, and the roofs recovered from its branches.
    let results: Vec<TreeResult> = crate::par::map(&trees, |tree| {
        let mut first_layer: i64 = -1;
        let mut tslices: Vec<Slice> = Vec::new();
        let mut roofs: Vec<(Vec<Ring>, i64, usize)> = Vec::new();
        for branch in tree {
            let mut mesh = Mesh::default();
            let (zlo, zhi) = extrude_branch(&branch.path, move_bounds_ro, cfg, h, branch.has_root, &mut mesh);
            let front = &move_bounds_ro[branch.path[0].0][branch.path[0].1];
            let back_e = branch.path.last().map(|&(l, i)| &move_bounds_ro[l][i]);
            let front_layer = front.state.layer_idx;
            let back_layer = back_e.map_or(front_layer, |e| e.state.layer_idx);
            let mut layer_begin = if branch.has_root {
                front_layer
            } else {
                front_layer.min(h.idx_ceil(zlo))
            };
            let layer_end = if branch.has_tip {
                back_layer
            } else {
                back_layer.max(h.idx_floor(zhi))
            } + 1;
            // Each layer of a branch is cut on its own, so a plate with one large tree still spreads the work.
            let mut slices: Vec<Shapes> = if layer_end > layer_begin {
                let zs: Vec<f64> = (layer_begin..layer_end)
                    .map(|l| 0.5 * (if l > 0 { h.z(l - 1) } else { 0.0 } + h.z(l)))
                    .collect();
                let tris = triangles_at(&mesh, &zs);
                crate::par::map_range(0..(layer_end - layer_begin) as u32, |i| {
                    let l = layer_begin + i64::from(i);
                    let s = slice_mesh(&mesh, zs[i as usize], &tris[i as usize]);
                    let coll = volumes.collision(0, l, true);
                    let mut a = geo::diff(&s, &coll);
                    // With something to take away, the slice is an overlay's own output, which clipping to the
                    // bed gives back unchanged when it lies well inside the bed.
                    if s.is_empty() || coll.is_empty() || !inside_box(perimeters::bounds(&a), bed_box) {
                        a = geo::inter(&a, &volumes.bed_area);
                    }
                    geo::remove_small(&mut a, tiny);
                    a
                })
            } else {
                Vec::new()
            };
            if slices.is_empty() {
                continue;
            }
            let num_empty = slices.iter().take_while(|s| s.is_empty()).count();
            if num_empty >= slices.len() {
                continue;
            }
            if num_empty > 0 {
                slices.drain(..num_empty);
                layer_begin += num_empty as i64;
            }
            let front_contact = slices[0].clone();
            let mut bottom_contacts: Vec<Shapes> = Vec::new();
            if branch.has_root {
                if front.state.to_model_gracious {
                    if cfg.support_floor_layers > 0 {
                        let mut contacts = if cfg.support_rests_on_model
                            && cfg.z_distance_bottom_layers > 0
                            && layer_begin > 0
                        {
                            front_contact.clone()
                        } else {
                            geo::inter(&front_contact, &volumes.placeable(0, layer_begin))
                        };
                        geo::remove_small(&mut contacts, tiny);
                        if contacts.is_empty()
                            && cfg.support_rests_on_model
                            && layer_begin > 0
                            && !front_contact.is_empty()
                        {
                            contacts.clone_from(&front_contact);
                        }
                        if !contacts.is_empty() {
                            bottom_contacts.push(contacts);
                        }
                    }
                } else if layer_begin > 0 {
                    // Hanging on the model: drop the bottom down onto whatever is under it.
                    let bottom_radius = elements::radius(cfg, &front.state);
                    let propagate_max = 5 * bottom_radius / cfg.layer_height;
                    let bottommost = if front.state.verylost {
                        0
                    } else {
                        (layer_begin - propagate_max).max(0)
                    };
                    let min_area = std::f64::consts::PI * (cfg.branch_radius as f64).m_powi(2);
                    let stop =
                        (0.2 * std::f64::consts::PI * (bottom_radius as f64).m_powi(2)).max(0.5 * min_area);
                    let mut extra: Vec<Shapes> = Vec::new();
                    let mut rest: Shapes = Vec::new();
                    let mut l = layer_begin - 1;
                    while l >= bottommost {
                        let coll_layer = if l == layer_begin - 1 { layer_begin } else { l };
                        let coll = volumes.collision(0, coll_layer, false);
                        rest = geo::diff(if rest.is_empty() { &front_contact } else { &rest }, &coll);
                        geo::remove_small(&mut rest, tiny);
                        if geo::area(&rest) < stop {
                            break;
                        }
                        extra.push(rest.clone());
                        l -= 1;
                    }
                    if cfg.support_floor_layers > 0 {
                        let mut contacts = if let Some(lowest) = extra.last() {
                            if cfg.support_rests_on_model
                                && cfg.z_distance_bottom_layers > 0
                                && layer_begin > 0
                            {
                                geo::inter(lowest, &volumes.bed_area)
                            } else {
                                geo::inter(lowest, &volumes.placeable(0, layer_begin))
                            }
                        } else if cfg.support_rests_on_model
                            && cfg.z_distance_bottom_layers > 0
                            && layer_begin > 0
                        {
                            front_contact.clone()
                        } else {
                            geo::inter(&front_contact, &volumes.placeable(0, layer_begin))
                        };
                        geo::remove_small(&mut contacts, tiny);
                        if !contacts.is_empty() {
                            bottom_contacts.push(contacts);
                        }
                        if bottom_contacts.is_empty()
                            && cfg.support_rests_on_model
                            && layer_begin > 0
                            && !front_contact.is_empty()
                        {
                            bottom_contacts.push(front_contact.clone());
                        }
                    }
                    layer_begin -= extra.len() as i64;
                    let mut new_slices: Vec<Shapes> = extra.into_iter().rev().collect();
                    new_slices.extend(slices);
                    slices = new_slices;
                }
                if cfg.support_rests_on_model
                    && front_layer > 0
                    && cfg.support_floor_layers > 0
                    && cfg.z_distance_bottom_layers > 0
                    && bottom_contacts.is_empty()
                    && !front_contact.is_empty()
                {
                    bottom_contacts.push(front_contact.clone());
                }
            }
            // Roofs the tips could not place: taken from the slices of this branch.
            if params.has_top_contacts {
                for &(l, i) in branch.path.iter().rev() {
                    let el = &move_bounds_ro[l][i];
                    if !el.state.has_pending_roof_recovery() {
                        break;
                    }
                    let si = el.state.layer_idx - layer_begin;
                    if si < 0 || si >= slices.len() as i64 || slices[si as usize].is_empty() {
                        continue;
                    }
                    if el.state.roof_recovery_dtt as usize > params.num_top_interface_layers {
                        continue;
                    }
                    let taken = std::mem::take(&mut slices[si as usize]);
                    roofs.push((
                        geo::rings(&taken).cloned().collect(),
                        el.state.layer_idx,
                        el.state.roof_recovery_dtt as usize,
                    ));
                }
            }
            while slices.last().is_some_and(Vec::is_empty) {
                slices.pop();
            }
            let layer_end = layer_begin + slices.len() as i64;
            if layer_begin < layer_end {
                let new_begin = if first_layer == -1 {
                    layer_begin
                } else {
                    first_layer.min(layer_begin)
                };
                let new_end = if first_layer == -1 {
                    layer_end
                } else {
                    (first_layer + tslices.len() as i64).max(layer_end)
                };
                let new_size = (new_end - new_begin) as usize;
                if first_layer != -1 && first_layer > new_begin {
                    let dif = (first_layer - new_begin) as usize;
                    let mut v = vec![Slice::default(); dif];
                    v.append(&mut tslices);
                    tslices = v;
                }
                tslices.resize(new_size, Slice::default());
                for l in layer_begin..layer_end {
                    let j = (l - layer_begin) as usize;
                    let src = std::mem::take(&mut slices[j]);
                    let bc = if j < bottom_contacts.len() {
                        std::mem::take(&mut bottom_contacts[j])
                    } else {
                        Vec::new()
                    };
                    if !src.is_empty() || !bc.is_empty() {
                        let dst = &mut tslices[(l - new_begin) as usize];
                        dst.num_branches += 1;
                        dst.polygons.extend(geo::rings(&src).cloned());
                        dst.bottom_contacts.extend(geo::rings(&bc).cloned());
                    }
                }
                first_layer = new_begin;
            }
        }
        (first_layer, tslices, roofs)
    });
    // Recovered roofs go in tree order, as Orca's threads would add them one tree at a time.
    let mut per_tree: Vec<(i64, Vec<Slice>)> = Vec::with_capacity(results.len());
    for (first, sl, roofs) in results {
        for (rings, layer, dtt) in roofs {
            placer.add_roof(rings, layer, dtt);
        }
        per_tree.push((first, sl));
    }
    let num_layers = per_tree
        .iter()
        .filter(|t| t.0 >= 0)
        .map(|t| t.0 as usize + t.1.len())
        .max()
        .unwrap_or(0);
    // Each tree's slice is united first when several of its branches meet there. Every slice is united on
    // its own, so all of them are worked out in parallel, then added layer by layer in tree order.
    let united: Vec<(usize, Slice)> = {
        let mut todo: Vec<(usize, Slice)> = Vec::new();
        for (first, tslices) in per_tree {
            if first < 0 {
                continue;
            }
            for (k, src) in tslices.into_iter().enumerate() {
                if !(src.polygons.is_empty() && src.bottom_contacts.is_empty()) {
                    todo.push((first as usize + k, src));
                }
            }
        }
        crate::par::map_owned(todo, |(at, src)| {
            if src.num_branches > 1 {
                let p = geo::rings(&union_halves(&src.polygons)).cloned().collect();
                let b = geo::rings(&geo::merge_rings(&src.bottom_contacts, FillRule::NonZero))
                    .cloned()
                    .collect();
                (
                    at,
                    Slice {
                        polygons: p,
                        bottom_contacts: b,
                        num_branches: src.num_branches,
                    },
                )
            } else {
                (at, src)
            }
        })
    };
    let mut slices: Vec<Slice> = vec![Slice::default(); num_layers];
    for (at, src) in united {
        let dst = &mut slices[at];
        dst.num_branches += 1;
        dst.polygons.extend(src.polygons);
        dst.bottom_contacts.extend(src.bottom_contacts);
    }
    let n = move_bounds.len().min(slices.len());
    let out: Vec<(Shapes, Shapes)> = crate::par::map_range(0..n as u32, |l| {
        let s = &slices[l as usize];
        let mut base = if s.polygons.is_empty() {
            Vec::new()
        } else {
            geo::merge_rings(&s.polygons, FillRule::NonZero)
        };
        let mut bottom = if s.bottom_contacts.is_empty() {
            Vec::new()
        } else {
            geo::merge_rings(&s.bottom_contacts, FillRule::NonZero)
        };
        if !base.is_empty() {
            base = super::smooth::smooth_outward(&base, cfg.support_line_width);
            base = geo::simplify(&base, (geo::sc(0.03) as f64).min(cfg.resolution as f64));
        }
        if let Some(top) = placer.top_contacts.get(l as usize).and_then(Option::as_ref)
            && !top.is_empty()
            && !base.is_empty()
        {
            let top_s = geo::from_rings(top.clone());
            base = geo::diff(&base, &top_s);
            if !bottom.is_empty() {
                bottom = geo::diff(&bottom, &top_s);
            }
        }
        if !bottom.is_empty() {
            base = geo::diff(&base, &bottom);
        }
        let base = if base.is_empty() { base } else { geo::union(&base) };
        (base, bottom)
    });
    let (base, bottom_contacts): (Vec<Shapes>, Vec<Shapes>) = out.into_iter().unzip();
    let _: Option<Pt> = None;
    Drawn {
        base,
        bottom_contacts,
    }
}
