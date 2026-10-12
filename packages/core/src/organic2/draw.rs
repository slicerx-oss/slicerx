// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Drawing the trees (spec 7.1 to 7.6): branch centers are smoothed and pushed out of the model, the
//! trees are split into branches, each branch becomes a closed tube mesh, and the tubes are sliced at the
//! middle of every layer.

use super::node::Node;
use super::ops::{self, P};
use super::params::Params;
use super::volumes::Volumes;
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::par::Init as _;
use crate::perimeters::{self, Shapes};

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt();
    if l <= 1e-12 {
        [0.0, 0.0, 1.0]
    } else {
        scale(a, 1.0 / l)
    }
}

fn mm2(p: P) -> [f64; 2] {
    [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE]
}

fn to_p2(q: [f64; 2]) -> P {
    ops::to_p(q[0] * SCALE, q[1] * SCALE)
}

/// Layer heights: the print Z of every tree layer, and the layer under a Z.
pub(crate) struct Heights<'a> {
    pub(crate) tops: &'a [f64],
}

impl Heights<'_> {
    pub(crate) fn top(&self, l: usize) -> f64 {
        self.tops.get(l).copied().unwrap_or(0.0)
    }
    pub(crate) fn bottom(&self, l: usize) -> f64 {
        l.checked_sub(1).map_or(0.0, |b| self.top(b))
    }
    /// The first layer whose print Z is at or above `z`.
    pub(crate) fn layer_at_or_above(&self, z: f64) -> usize {
        self.tops.partition_point(|&t| t < z - 1e-9)
    }
    /// The last layer whose print Z is at or below `z`.
    pub(crate) fn layer_at_or_below(&self, z: f64) -> usize {
        self.tops.partition_point(|&t| t <= z + 1e-9).saturating_sub(1)
    }
}

/// Node address: layer and index.
type Id = (usize, usize);

fn node(layers: &[Vec<Node>], id: Id) -> Option<&Node> {
    layers.get(id.0).and_then(|v| v.get(id.1))
}

/// One edge of a collision outline, as its two end points.
type Edge = ([f64; 2], [f64; 2]);

/// Edges of the collision area of one layer, bucketed on a grid for nearest-edge queries.
struct EdgeGrid {
    cell: f64,
    buckets: std::collections::HashMap<(i64, i64), Vec<Edge>>,
}

impl EdgeGrid {
    #[allow(clippy::cast_possible_truncation, reason = "grid cells on the plate")]
    fn key(&self, x: f64, y: f64) -> (i64, i64) {
        ((x / self.cell).floor() as i64, (y / self.cell).floor() as i64)
    }

    fn new(area: &Shapes) -> Self {
        let mut g = Self {
            cell: 2.0,
            buckets: std::collections::HashMap::new(),
        };
        for r in area.iter().flatten() {
            let n = r.len();
            for i in 0..n {
                let (Some(&a), Some(&b)) = (r.get(i), r.get((i + 1) % n)) else {
                    continue;
                };
                let (a, b) = (mm2(a), mm2(b));
                let (k0, k1) = (
                    g.key(a[0].min(b[0]), a[1].min(b[1])),
                    g.key(a[0].max(b[0]), a[1].max(b[1])),
                );
                for x in k0.0..=k1.0 {
                    for y in k0.1..=k1.1 {
                        g.buckets.entry((x, y)).or_default().push((a, b));
                    }
                }
            }
        }
        g
    }

    /// The nearest edge point to `p` within `r`, with its distance.
    fn nearest(&self, p: [f64; 2], r: f64) -> Option<([f64; 2], f64)> {
        let (k0, k1) = (self.key(p[0] - r, p[1] - r), self.key(p[0] + r, p[1] + r));
        let mut best: Option<([f64; 2], f64)> = None;
        for x in k0.0..=k1.0 {
            for y in k0.1..=k1.1 {
                let Some(edges) = self.buckets.get(&(x, y)) else {
                    continue;
                };
                for &(a, b) in edges {
                    let d = [b[0] - a[0], b[1] - a[1]];
                    let l2 = d[0] * d[0] + d[1] * d[1];
                    let t = if l2 > 0.0 {
                        (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let q = [a[0] + d[0] * t, a[1] + d[1] * t];
                    let dist = (p[0] - q[0]).m_hypot(p[1] - q[1]);
                    if dist <= r && best.is_none_or(|(_, bd)| dist < bd) {
                        best = Some((q, dist));
                    }
                }
            }
        }
        best
    }
}

/// Smooths the centers and pushes them out of the model (spec 7.2).
#[allow(clippy::too_many_lines, reason = "one iteration loop")]
pub(crate) fn smooth(p: &Params, v: &Volumes<'_>, hs: &Heights<'_>, layers: &mut [Vec<Node>]) {
    let ids: Vec<Id> = layers
        .iter()
        .enumerate()
        .flat_map(|(l, ns)| (0..ns.len()).map(move |k| (l, k)))
        .collect();
    let index: std::collections::HashMap<Id, usize> =
        ids.iter().enumerate().map(|(i, &id)| (id, i)).collect();
    let mut pos: Vec<[f64; 2]> = ids
        .iter()
        .map(|&id| node(layers, id).and_then(|n| n.center).map_or([0.0, 0.0], mm2))
        .collect();
    let radius: Vec<f64> = ids
        .iter()
        .map(|&id| node(layers, id).map_or(0.0, |n| p.drawn_radius(f64::from(n.d), n.e, n.f)))
        .collect();
    let child: Vec<Option<usize>> = ids
        .iter()
        .map(|&(l, k)| {
            let c = node(layers, (l, k)).and_then(|n| n.child)?;
            index.get(&(l.checked_sub(1)?, c)).copied()
        })
        .collect();
    let parents: Vec<Vec<usize>> = ids
        .iter()
        .map(|&(l, k)| {
            node(layers, (l, k)).map_or_else(Vec::new, |n| {
                n.parents
                    .iter()
                    .filter_map(|&q| index.get(&(l + 1, q)).copied())
                    .collect()
            })
        })
        .collect();
    let locked: Vec<bool> = ids
        .iter()
        .enumerate()
        .map(|(i, &(l, _))| {
            parents.get(i).is_none_or(Vec::is_empty) || (child.get(i).copied().flatten().is_none() && l > 0)
        })
        .collect();
    let z: Vec<f64> = ids.iter().map(|&(l, _)| hs.top(l)).collect();
    // Z of the root below each node (children come before parents in `ids`, layer by layer).
    let mut root_z = z.clone();
    for i in 0..ids.len() {
        if let Some(Some(c)) = child.get(i)
            && let Some(&rz) = root_z.get(*c)
            && let Some(slot) = root_z.get_mut(i)
        {
            *slot = rz;
        }
    }
    // Z of the lowest tip above each node.
    let mut tip_z = z.clone();
    for i in (0..ids.len()).rev() {
        let m = parents.get(i).map(|ps| {
            ps.iter()
                .filter_map(|&q| tip_z.get(q).copied())
                .fold(f64::INFINITY, f64::min)
        });
        if let Some(m) = m.filter(|m| m.is_finite())
            && let Some(slot) = tip_z.get_mut(i)
        {
            *slot = m;
        }
    }
    let span: Vec<(usize, usize)> = (0..ids.len())
        .map(|i| {
            let (zi, ri) = (
                z.get(i).copied().unwrap_or(0.0),
                radius.get(i).copied().unwrap_or(0.0),
            );
            let lo = root_z.get(i).copied().unwrap_or(zi).max(zi - ri);
            let hi = tip_z.get(i).copied().unwrap_or(zi).min(zi + ri);
            (hs.layer_at_or_above(lo), hs.layer_at_or_below(hi))
        })
        .collect();
    let grids: Vec<std::sync::OnceLock<EdgeGrid>> =
        (0..layers.len()).map(|_| std::sync::OnceLock::new()).collect();
    let grid = |l: usize| -> Option<&EdgeGrid> {
        grids
            .get(l)
            .map(|g| g.once(|| EdgeGrid::new(&v.collision(0.0, l, true))))
    };
    let m_slow = p.m_slow;
    for _ in 0..100 {
        let prev = pos.clone();
        let at = |i: usize| prev.get(i).copied().unwrap_or([0.0, 0.0]);
        let limit = |i: usize, mut c: [f64; 2]| -> [f64; 2] {
            let ri = radius.get(i).copied().unwrap_or(0.0);
            let neighbors = child
                .get(i)
                .copied()
                .flatten()
                .into_iter()
                .chain(parents.get(i).into_iter().flatten().copied());
            for j in neighbors {
                let q = at(j);
                let rj = radius.get(j).copied().unwrap_or(0.0);
                let current = (at(i)[0] - q[0]).m_hypot(at(i)[1] - q[1]);
                let allowed = current.max((ri - rj).abs() + m_slow);
                let d = (c[0] - q[0]).m_hypot(c[1] - q[1]);
                if d > allowed && d > 0.0 {
                    let s = allowed / d;
                    c = [q[0] + (c[0] - q[0]) * s, q[1] + (c[1] - q[1]) * s];
                }
            }
            c
        };
        let idx: Vec<usize> = (0..ids.len()).collect();
        let moved: Vec<([f64; 2], f64)> = crate::par::map_fine(&idx, |&i| {
            let old = at(i);
            if locked.get(i).copied().unwrap_or(true) {
                return (old, 0.0);
            }
            let (zi, ri) = (
                z.get(i).copied().unwrap_or(0.0),
                radius.get(i).copied().unwrap_or(0.0),
            );
            let (lo, hi) = span.get(i).copied().unwrap_or((0, 0));
            let mut deepest: Option<([f64; 2], f64)> = None;
            for l in lo..=hi {
                let dz = hs.top(l) - zi;
                let cr2 = ri * ri - dz * dz;
                if cr2 <= 0.0 {
                    continue;
                }
                let cr = cr2.sqrt();
                if let Some((q, d)) = grid(l).and_then(|g| g.nearest(old, cr)) {
                    let depth = cr - d;
                    if deepest.is_none_or(|(_, bd)| depth > bd) {
                        deepest = Some((q, depth));
                    }
                }
            }
            let mut cand = old;
            let mut hit = 0.0;
            if let Some((q, depth)) = deepest.filter(|&(_, d)| d > 0.0) {
                hit = depth;
                let n = (depth + 0.1).clamp(0.0, 0.5);
                let push = if p.s.quirks.nudge_squared { n * n } else { n };
                let dir = [old[0] - q[0], old[1] - q[1]];
                let l = dir[0].m_hypot(dir[1]);
                if l > 1e-12 {
                    cand = [old[0] + dir[0] / l * push, old[1] + dir[1] / l * push];
                }
                cand = limit(i, cand);
            }
            // Laplacian smoothing toward the neighbors.
            let ps = parents.get(i).map_or(&[][..], Vec::as_slice);
            let np = ps.len();
            if np > 0 {
                let mut sum = [0.0, 0.0];
                let mut weight = 0.0;
                for &q in ps {
                    let pq = at(q);
                    sum = [sum[0] + pq[0] * ri, sum[1] + pq[1] * ri];
                    weight += ri;
                }
                if let Some(c) = child.get(i).copied().flatten() {
                    let pc = at(c);
                    let wc = ri * f64::from(u32::try_from(np).unwrap_or(1));
                    sum = [sum[0] + pc[0] * wc, sum[1] + pc[1] * wc];
                    weight += wc;
                }
                if weight > 0.0 {
                    let avg = [sum[0] / weight, sum[1] / weight];
                    let target = [0.5 * cand[0] + 0.5 * avg[0], 0.5 * cand[1] + 0.5 * avg[1]];
                    let d = [target[0] - cand[0], target[1] - cand[1]];
                    let l = d[0].m_hypot(d[1]);
                    let s = if l > 0.2 { 0.2 / l } else { 1.0 };
                    cand = limit(i, [cand[0] + d[0] * s, cand[1] + d[1] * s]);
                }
            }
            (cand, hit)
        });
        let mut worst: f64 = 0.0;
        for (i, (c, hit)) in moved.into_iter().enumerate() {
            if let Some(slot) = pos.get_mut(i) {
                *slot = c;
            }
            worst = worst.max(hit);
        }
        if worst <= 1e-4 {
            break;
        }
    }
    for (i, &(l, k)) in ids.iter().enumerate() {
        if let (Some(n), Some(&c)) = (layers.get_mut(l).and_then(|v| v.get_mut(k)), pos.get(i))
            && n.center.is_some()
        {
            n.center = Some(to_p2(c));
        }
    }
}

/// One branch: nodes from bottom to top.
pub(crate) struct Branch {
    pub(crate) nodes: Vec<Id>,
    pub(crate) has_root: bool,
    pub(crate) has_tip: bool,
}

/// Splits the trees into branches between bifurcations (spec 7.3).
pub(crate) fn branches(layers: &[Vec<Node>]) -> Vec<Branch> {
    let mut out = Vec::new();
    let mut starts: Vec<(Id, bool)> = Vec::new();
    for (l, ns) in layers.iter().enumerate() {
        for (k, n) in ns.iter().enumerate() {
            if n.child.is_none() && !n.parents.is_empty() {
                starts.push(((l, k), true));
            }
        }
    }
    while let Some((start, root)) = starts.pop() {
        let Some(sn) = node(layers, start) else { continue };
        for &q in &sn.parents {
            let mut path = vec![start];
            let mut cur = (start.0 + 1, q);
            loop {
                path.push(cur);
                let ps = node(layers, cur).map_or(&[][..], |n| n.parents.as_slice());
                match ps {
                    [one] => cur = (cur.0 + 1, *one),
                    [] => {
                        out.push(Branch {
                            nodes: path,
                            has_root: root,
                            has_tip: true,
                        });
                        break;
                    }
                    _ => {
                        starts.push((cur, false));
                        out.push(Branch {
                            nodes: path,
                            has_root: root,
                            has_tip: false,
                        });
                        break;
                    }
                }
            }
        }
    }
    out
}

/// A closed triangle mesh.
#[derive(Default)]
pub(crate) struct Mesh {
    pub(crate) verts: Vec<V3>,
    pub(crate) tris: Vec<[usize; 3]>,
}

impl Mesh {
    fn ring(&mut self, c: V3, axis: V3, u: V3, r: f64, n: usize) -> Vec<usize> {
        let w = cross(axis, u);
        let start = self.verts.len();
        for i in 0..n {
            #[allow(clippy::cast_precision_loss, reason = "a few hundred sides")]
            let a = std::f64::consts::TAU * i as f64 / n as f64;
            let (s, co) = a.m_sin_cos();
            self.verts.push(add(c, add(scale(u, r * co), scale(w, r * s))));
        }
        (start..start + n).collect()
    }

    fn vert(&self, i: usize) -> V3 {
        self.verts.get(i).copied().unwrap_or([0.0; 3])
    }

    /// Joins ring `a` (below) to ring `b` (above), from their closest pair, taking the shorter diagonal.
    fn strip(&mut self, a: &[usize], b: &[usize]) {
        let (na, nb) = (a.len(), b.len());
        if na == 0 || nb == 0 {
            return;
        }
        let a0 = a.first().copied().unwrap_or(0);
        let mut j0 = 0;
        let mut best = f64::INFINITY;
        for (j, &bj) in b.iter().enumerate() {
            let d = sub(self.vert(bj), self.vert(a0));
            if dot(d, d) < best {
                best = dot(d, d);
                j0 = j;
            }
        }
        let ai = |i: usize| a.get(i % na).copied().unwrap_or(0);
        let bi = |j: usize| b.get((j0 + j) % nb).copied().unwrap_or(0);
        let (mut i, mut j) = (0, 0);
        while i < na || j < nb {
            let adv_a = if i >= na {
                false
            } else if j >= nb {
                true
            } else {
                let da = sub(self.vert(ai(i + 1)), self.vert(bi(j)));
                let db = sub(self.vert(bi(j + 1)), self.vert(ai(i)));
                dot(da, da) <= dot(db, db)
            };
            if adv_a {
                self.tris.push([ai(i), ai(i + 1), bi(j)]);
                i += 1;
            } else {
                self.tris.push([ai(i), bi(j + 1), bi(j)]);
                j += 1;
            }
        }
    }

    /// A hemisphere on ring `base` (center `c`, radius `r`), bulging along `dir`; `up` says whether the
    /// cap closes the top of the tube (so the base ring is below it).
    fn cap(&mut self, base: &[usize], c: V3, dir: V3, u: V3, r: f64, up: bool) {
        let n = base.len();
        let steps = (n / 4).clamp(2, 16);
        let mut prev = base.to_vec();
        for s in 1..steps {
            #[allow(clippy::cast_precision_loss, reason = "a few steps")]
            let phi = std::f64::consts::FRAC_PI_2 * s as f64 / steps as f64;
            let (sn, cs) = phi.m_sin_cos();
            let ring = self.ring(add(c, scale(dir, r * sn)), dir, u, r * cs, n);
            if up {
                self.strip(&prev, &ring);
            } else {
                self.strip(&ring, &prev);
            }
            prev = ring;
        }
        let pole = self.verts.len();
        self.verts.push(add(c, scale(dir, r)));
        let m = prev.len();
        for i in 0..m {
            let (a, b) = (
                prev.get(i).copied().unwrap_or(0),
                prev.get((i + 1) % m).copied().unwrap_or(0),
            );
            if up {
                self.tris.push([a, b, pole]);
            } else {
                self.tris.push([b, a, pole]);
            }
        }
    }

    /// Cuts the mesh at height `z` into loops (internal units).
    fn slice(&self, z: f64) -> Vec<Vec<Point>> {
        use std::collections::HashMap;
        let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };
        let mut segs: Vec<((usize, usize), (usize, usize))> = Vec::new();
        for t in &self.tris {
            let [a, b, c] = *t;
            let above = |i: usize| self.vert(i)[2] >= z;
            let mut cut: Vec<(usize, usize)> = Vec::with_capacity(2);
            for (x, y) in [(a, b), (b, c), (c, a)] {
                if above(x) != above(y) {
                    cut.push(key(x, y));
                }
            }
            if let [e0, e1] = cut.as_slice() {
                segs.push((*e0, *e1));
            }
        }
        let mut by_edge: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
        for (i, (e0, e1)) in segs.iter().enumerate() {
            by_edge.entry(*e0).or_default().push(i);
            by_edge.entry(*e1).or_default().push(i);
        }
        let point = |e: (usize, usize)| {
            let (p0, p1) = (self.vert(e.0), self.vert(e.1));
            let t = if (p1[2] - p0[2]).abs() > 1e-12 {
                (z - p0[2]) / (p1[2] - p0[2])
            } else {
                0.5
            };
            let x = p0[0] + (p1[0] - p0[0]) * t;
            let y = p0[1] + (p1[1] - p0[1]) * t;
            Point::from_mm(x, y)
        };
        let mut used = vec![false; segs.len()];
        let mut loops = Vec::new();
        for s0 in 0..segs.len() {
            if used.get(s0).copied().unwrap_or(true) {
                continue;
            }
            let Some(&(first, mut at)) = segs.get(s0) else {
                continue;
            };
            if let Some(u) = used.get_mut(s0) {
                *u = true;
            }
            let mut ring = vec![point(first)];
            loop {
                ring.push(point(at));
                let next = by_edge
                    .get(&at)
                    .and_then(|v| v.iter().copied().find(|&s| !used.get(s).copied().unwrap_or(true)));
                let Some(s) = next else { break };
                if let Some(u) = used.get_mut(s) {
                    *u = true;
                }
                let Some(&(e0, e1)) = segs.get(s) else { break };
                at = if e0 == at { e1 } else { e0 };
                if at == first {
                    break;
                }
            }
            if ring.len() >= 3 {
                loops.push(ring);
            }
        }
        loops
    }
}

/// A vector at a right angle to `axis`, as close to `hint` as possible.
fn perpendicular(axis: V3, hint: V3) -> V3 {
    let h = sub(hint, scale(axis, dot(hint, axis)));
    if dot(h, h) > 1e-12 {
        norm(h)
    } else {
        let alt = if axis[0].abs() < 0.9 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        norm(sub(alt, scale(axis, dot(alt, axis))))
    }
}

/// The tube mesh of a branch (spec 7.4), and the lowest and highest Z of its caps.
pub(crate) fn tube(
    p: &Params,
    hs: &Heights<'_>,
    layers: &[Vec<Node>],
    b: &Branch,
) -> Option<(Mesh, f64, f64)> {
    let pts: Vec<(V3, f64, usize)> = b
        .nodes
        .iter()
        .filter_map(|&id| {
            let n = node(layers, id)?;
            let c = mm2(n.center?);
            Some((
                [c[0], c[1], hs.top(id.0)],
                p.drawn_radius(f64::from(n.d), n.e, n.f),
                id.0,
            ))
        })
        .collect();
    if pts.len() < 2 {
        return None;
    }
    let mut m = Mesh::default();
    let mut rings: Vec<Vec<usize>> = Vec::new();
    let mut u_prev = [1.0, 0.0, 0.0];
    let count = pts.len();
    let mut axes = Vec::with_capacity(count);
    for i in 0..count {
        let here = pts.get(i).map_or([0.0; 3], |t| t.0);
        let din = (i > 0)
            .then(|| pts.get(i - 1).map(|t| norm(sub(here, t.0))))
            .flatten();
        let dout = pts.get(i + 1).map(|t| norm(sub(t.0, here)));
        let axis = match (din, dout) {
            (Some(a), Some(b)) => norm(add(a, b)),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => [0.0, 0.0, 1.0],
        };
        axes.push(axis);
    }
    let sides = pts.iter().map(|t| ops::circle_sides(t.1)).max().unwrap_or(8) as usize;
    for (i, (c, r, _)) in pts.iter().enumerate() {
        let axis = axes.get(i).copied().unwrap_or([0.0, 0.0, 1.0]);
        let u = perpendicular(axis, u_prev);
        u_prev = u;
        rings.push(m.ring(*c, axis, u, *r, sides));
    }
    for w in rings.windows(2) {
        if let [a, b] = w {
            m.strip(a, b);
        }
    }
    let (first, last) = (pts.first()?, pts.last()?);
    let (first_ring, last_ring) = (rings.first()?.clone(), rings.last()?.clone());
    let a0 = axes.first().copied().unwrap_or([0.0, 0.0, 1.0]);
    let a1 = axes.last().copied().unwrap_or([0.0, 0.0, 1.0]);
    let mut lo = first.0[2];
    let mut hi = last.0[2];
    if b.has_root && first.2 == 0 {
        // A flat foot: a vertical cylinder down to the bed, closed by a disc.
        let up = [0.0, 0.0, 1.0];
        let base_c = [first.0[0], first.0[1], 0.0];
        let base = m.ring(base_c, up, perpendicular(up, u_prev), first.1, sides);
        m.strip(&base, &first_ring);
        let mid = m.verts.len();
        m.verts.push(base_c);
        for i in 0..base.len() {
            let (x, y) = (
                base.get(i).copied().unwrap_or(0),
                base.get((i + 1) % base.len()).copied().unwrap_or(0),
            );
            m.tris.push([y, x, mid]);
        }
        lo = 0.0;
    } else {
        let dir = scale(a0, -1.0);
        let u = perpendicular(a0, [1.0, 0.0, 0.0]);
        m.cap(&first_ring, first.0, dir, u, first.1, false);
        lo = lo.min(first.0[2] - first.1);
    }
    let u = perpendicular(a1, [1.0, 0.0, 0.0]);
    m.cap(&last_ring, last.0, a1, u, last.1, true);
    hi = hi.max(last.0[2] + last.1);
    Some((m, lo, hi))
}

/// The slices of one branch: start layer and one area per layer up from it.
pub(crate) struct Slices {
    pub(crate) start: usize,
    pub(crate) areas: Vec<Shapes>,
}

/// Slices a branch tube at the middle of every layer it spans (spec 7.5).
pub(crate) fn slice_branch(
    p: &Params,
    v: &Volumes<'_>,
    hs: &Heights<'_>,
    layers: &[Vec<Node>],
    b: &Branch,
) -> Option<Slices> {
    let (mesh, lo, hi) = tube(p, hs, layers, b)?;
    let first = b.nodes.first()?.0;
    let last = b.nodes.last()?.0;
    let bottom = if b.has_root {
        first
    } else {
        first.min(hs.layer_at_or_above(lo))
    };
    let top = if b.has_tip {
        last
    } else {
        last.max(hs.layer_at_or_below(hi))
    };
    let top = top.min(hs.tops.len().saturating_sub(1));
    let bed = v.bed().clone();
    let mut areas: Vec<Shapes> = Vec::new();
    for l in bottom..=top {
        let z = f64::midpoint(hs.bottom(l), hs.top(l));
        let loops = mesh.slice(z);
        let s = perimeters::shapes_from_loops_mode(&loops, 125, perimeters::Slicing::CloseHoles, 0);
        let c = ops::grow(&v.collision(0.0, l, true), 0.001);
        let s = ops::inter(&ops::diff(&s, &c), &bed);
        let s: Shapes = s.into_iter().filter(|sh| ops::shape_area(sh) >= 1e-6).collect();
        areas.push(s);
    }
    let lead = areas.iter().take_while(|a| a.is_empty()).count();
    while areas.last().is_some_and(Vec::is_empty) {
        areas.pop();
    }
    if lead >= areas.len() {
        return None;
    }
    let areas = areas.split_off(lead);
    Some(Slices {
        start: bottom + lead,
        areas,
    })
}
