// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! How exposed each part of a model's surface is, for the seam placer. The same steps as Orca's
//! `SeamPlacer.cpp` (`compute_global_occlusion`, `raycast_visibility`, `calculate_point_visibility`):
//! the mesh is decimated to about 16000 triangles by collapsing short edges (`ShortEdgeCollapse.cpp`),
//! 30000 points are sampled over it with a fixed seed (`TriangleSetSampling.cpp`), 5 by 5 rays leave each
//! sample over its hemisphere and every ray that hits the front of the model takes a 25th off the
//! sample's visibility, and a point on a wall reads the weighted mean of the samples near it.
//!
//! Orca's random numbers come from the C++ standard library (`std::mt19937_64` with seed 27644437 and
//! `std::shuffle`); the generator is the same here, the shuffle is our own Fisher-Yates, so the
//! decimated mesh differs from Orca's while its samples follow the same sequence.

use std::collections::HashMap;

/// A triangle mesh in plate coordinates, mm.
#[derive(Debug, Clone, Default)]
pub(crate) struct Soup {
    pub verts: Vec<[f32; 3]>,
    pub tris: Vec<[u32; 3]>,
}

type V3 = [f32; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn mul(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn norm(a: V3) -> f32 {
    dot(a, a).sqrt()
}
fn unit(a: V3) -> V3 {
    let n = norm(a);
    if n > 0.0 { mul(a, 1.0 / n) } else { a }
}

impl Soup {
    fn at(&self, i: u32) -> V3 {
        self.verts.get(i as usize).copied().unwrap_or([0.0; 3])
    }

    fn corners(&self, t: usize) -> [V3; 3] {
        let [a, b, c] = self.tris.get(t).copied().unwrap_or([0; 3]);
        [self.at(a), self.at(b), self.at(c)]
    }

    /// Unit normal of triangle `t`, `(b - a) x (c - b)` as Orca writes it.
    fn normal(&self, t: usize) -> V3 {
        let [a, b, c] = self.corners(t);
        unit(cross(sub(b, a), sub(c, b)))
    }
}

/// `std::mt19937_64`.
struct Mt64 {
    mt: [u64; 312],
    i: usize,
}

impl Mt64 {
    fn new(seed: u64) -> Self {
        let mut mt = [0u64; 312];
        mt[0] = seed;
        for i in 1..312 {
            let p = mt[i - 1];
            mt[i] = 6_364_136_223_846_793_005u64
                .wrapping_mul(p ^ (p >> 62))
                .wrapping_add(i as u64);
        }
        Self { mt, i: 312 }
    }

    fn next(&mut self) -> u64 {
        if self.i >= 312 {
            for i in 0..312 {
                let x = (self.mt[i] & 0xFFFF_FFFF_8000_0000) | (self.mt[(i + 1) % 312] & 0x7FFF_FFFF);
                let mut xa = x >> 1;
                if x & 1 == 1 {
                    xa ^= 0xB502_6F5A_A966_19E9;
                }
                self.mt[i] = self.mt[(i + 156) % 312] ^ xa;
            }
            self.i = 0;
        }
        let mut y = self.mt[self.i];
        self.i += 1;
        y ^= (y >> 29) & 0x5555_5555_5555_5555;
        y ^= (y << 17) & 0x71D6_7FFF_EDA6_0000;
        y ^= (y << 37) & 0xFFF7_EEE0_0000_0000;
        y ^ (y >> 43)
    }

    /// `std::uniform_real_distribution<double>` over [0, 1).
    #[allow(
        clippy::cast_precision_loss,
        reason = "a 64 bit draw to a double, as the library does"
    )]
    fn real(&mut self) -> f64 {
        let v = self.next() as f64 / 18_446_744_073_709_551_616.0;
        if v >= 1.0 { 1.0 - f64::EPSILON / 2.0 } else { v }
    }

    /// An index below `n`, by rejection on the low bits.
    fn below(&mut self, n: usize) -> usize {
        if n <= 1 {
            return 0;
        }
        let bits = usize::BITS - (n - 1).leading_zeros();
        let mask = if bits >= 64 { u64::MAX } else { (1u64 << bits) - 1 };
        loop {
            let v = usize::try_from(self.next() & mask).unwrap_or(usize::MAX);
            if v < n {
                return v;
            }
        }
    }
}

fn root(map: &mut [usize], i: usize) -> usize {
    let mut r = i;
    while let Some(&next) = map.get(r)
        && next != r
    {
        r = next;
    }
    // Every vertex on the way now points at the root.
    let mut c = i;
    while c != r {
        let Some(slot) = map.get_mut(c) else { break };
        c = std::mem::replace(slot, r);
    }
    r
}

/// Orca `its_short_edge_collpase`: merges vertices along short edges, shortest allowance first and
/// growing, in random order, until at most `target` triangles remain. A merge keeps the vertex that
/// defines the shape more (the lower smallest dot product of its normal with its faces' normals).
#[allow(clippy::too_many_lines, clippy::cast_possible_wrap, clippy::cast_sign_loss)]
pub(crate) fn collapse(mesh: &mut Soup, target: usize) {
    if mesh.tris.len() <= target {
        return;
    }
    let nv = mesh.verts.len();
    let mut map: Vec<usize> = (0..nv).collect();
    let nf = mesh.tris.len();
    let mut removed = vec![false; nf];
    // Neighbor across edge k (from vertex k to k + 1), -1 when none: the last face (Orca's map keeps the
    // last insert) with the edge running the other way, found in the directed edges sorted by key and face.
    let key = |a: u32, b: u32| (u64::from(a) << 32) | u64::from(b);
    let mut edges: Vec<(u64, u32)> = Vec::with_capacity(nf * 3);
    for (f, t) in mesh.tris.iter().enumerate() {
        for k in 0..3 {
            if let (Some(&a), Some(&b)) = (t.get(k), t.get((k + 1) % 3)) {
                #[allow(clippy::cast_possible_truncation, reason = "face counts fit in u32")]
                edges.push((key(a, b), f as u32));
            }
        }
    }
    crate::par::sort(&mut edges);
    let across = |a: u32, b: u32| {
        let k = key(b, a);
        let end = edges.partition_point(|e| e.0 <= k);
        end.checked_sub(1)
            .and_then(|i| edges.get(i))
            .filter(|e| e.0 == k)
            .map(|e| e.1)
    };
    let mut nb: Vec<[i64; 3]> = crate::par::map_fine(&mesh.tris, |t| {
        let mut n = [-1i64; 3];
        for k in 0..3 {
            if let (Some(&a), Some(&b)) = (t.get(k), t.get((k + 1) % 3))
                && let Some(o) = across(a, b)
                && let Some(slot) = n.get_mut(k)
            {
                *slot = i64::from(o);
            }
        }
        n
    });
    // Smallest dot product of a vertex normal with its face normals (Nelson Max weights).
    let mut vn = vec![[0.0f32; 3]; nv];
    let mut vw = vec![0.0f32; nv];
    for (f, t) in mesh.tris.iter().enumerate() {
        let n = mesh.normal(f);
        let [a, b, c] = mesh.corners(f);
        let (e0, e1, e2) = (norm(sub(a, b)), norm(sub(b, c)), norm(sub(c, a)));
        for (k, w) in [e0 * e2, e0 * e1, e1 * e2].into_iter().enumerate() {
            if let Some(&vi) = t.get(k) {
                let vi = vi as usize;
                if let (Some(s), Some(c)) = (vn.get_mut(vi), vw.get_mut(vi)) {
                    *s = add(*s, mul(n, w));
                    *c += w;
                }
            }
        }
    }
    let mut min_dot = vec![1.0f32; nv];
    for (f, t) in mesh.tris.iter().enumerate() {
        let n = mesh.normal(f);
        for &vi in t {
            let vi = vi as usize;
            let (Some(v), Some(w)) = (vn.get(vi), vw.get(vi)) else {
                continue;
            };
            let d = dot(n, mul(*v, 1.0 / *w));
            if let Some(m) = min_dot.get_mut(vi) {
                *m = m.min(d);
            }
        }
    }
    let mut rng = Mt64::new(27_644_437);
    let mut faces: Vec<usize> = (0..nf).collect();
    let mut ratio = 1.0f32;
    let mut edge_len = 0.2f32;
    while faces.len() > target {
        edge_len *= 1.0 + 1.0 - ratio;
        let max2 = edge_len * edge_len;
        // Random order: libc++ walks forward with a shrinking range.
        let n = faces.len();
        for i in 0..n.saturating_sub(1) {
            let j = rng.below(n - i);
            if j != 0 {
                faces.swap(i, i + j);
            }
        }
        let mut allowed = faces.len() as i64 - target as i64;
        for &f in &faces {
            if removed.get(f).copied().unwrap_or(true) {
                continue;
            }
            for k in 0..3 {
                let Some(t) = mesh.tris.get(f).copied() else { break };
                let mut keep = root(&mut map, t.get(k).copied().unwrap_or(0) as usize);
                let mut drop = root(&mut map, t.get((k + 1) % 3).copied().unwrap_or(0) as usize);
                let (pk, pd) = (
                    mesh.verts.get(keep).copied().unwrap_or([0.0; 3]),
                    mesh.verts.get(drop).copied().unwrap_or([0.0; 3]),
                );
                let d = sub(pk, pd);
                if dot(d, d) > max2 {
                    continue;
                }
                if min_dot.get(drop).copied().unwrap_or(1.0) < min_dot.get(keep).copied().unwrap_or(1.0) {
                    std::mem::swap(&mut keep, &mut drop);
                }
                let target_of_keep = map.get(keep).copied().unwrap_or(keep);
                if let Some(s) = map.get_mut(drop) {
                    *s = target_of_keep;
                }
                let other = nb.get(f).and_then(|n| n.get(k)).copied().unwrap_or(-1);
                for (face, from) in [(f as i64, other), (other, f as i64)] {
                    if face < 0 {
                        continue;
                    }
                    let face = face as usize;
                    if let Some(r) = removed.get_mut(face) {
                        *r = true;
                    }
                    let nbrs = nb.get(face).copied().unwrap_or([-1; 3]);
                    let a = if nbrs[0] == from { nbrs[1] } else { nbrs[0] };
                    let b = if nbrs[2] == from { nbrs[1] } else { nbrs[2] };
                    // Orca tests `> 0`, so face 0 is never patched.
                    for (this, replacement) in [(a, b), (b, a)] {
                        if this > 0
                            && let Some(n) = nb.get_mut(this as usize)
                        {
                            for x in n.iter_mut() {
                                if *x == face as i64 {
                                    *x = replacement;
                                    break;
                                }
                            }
                        }
                    }
                }
                allowed -= 2;
                break;
            }
            if allowed <= 0 {
                break;
            }
        }
        let before = faces.len();
        faces.retain(|&f| !removed.get(f).copied().unwrap_or(true));
        ratio = (before - faces.len()) as f32 / before as f32;
        if before == faces.len() && edge_len > 1e6 {
            break;
        }
    }
    let mut remap: HashMap<usize, u32> = HashMap::new();
    let mut verts: Vec<V3> = Vec::new();
    let mut tris: Vec<[u32; 3]> = Vec::with_capacity(faces.len());
    for &f in &faces {
        let Some(t) = mesh.tris.get(f).copied() else {
            continue;
        };
        let r: Vec<usize> = t.iter().map(|&v| root(&mut map, v as usize)).collect();
        if r.len() < 3 || r[0] == r[1] || r[1] == r[2] || r[2] == r[0] {
            continue;
        }
        let mut face = [0u32; 3];
        for (k, &v) in r.iter().enumerate() {
            let id = *remap.entry(v).or_insert_with(|| {
                verts.push(mesh.verts.get(v).copied().unwrap_or([0.0; 3]));
                (verts.len() - 1) as u32
            });
            if let Some(s) = face.get_mut(k) {
                *s = id;
            }
        }
        tris.push(face);
    }
    mesh.verts = verts;
    mesh.tris = tris;
}

/// Points spread over the surface, with the normal of the triangle each lies on.
pub(crate) struct Samples {
    pub pos: Vec<V3>,
    pub nrm: Vec<V3>,
    /// The triangle each sample lies on.
    pub tri: Vec<usize>,
    pub total_area: f32,
}

/// Orca `sample_its_uniform_parallel`: `count` points, a triangle drawn by area and a point in it.
#[allow(clippy::cast_possible_truncation, reason = "samples are single precision")]
pub(crate) fn sample(mesh: &Soup, count: usize) -> Samples {
    let mut cumulative: Vec<f32> = Vec::with_capacity(mesh.tris.len());
    let mut sum = 0.0f32;
    for t in 0..mesh.tris.len() {
        let [a, b, c] = mesh.corners(t);
        sum += 0.5 * norm(cross(sub(b, a), sub(c, a)));
        cumulative.push(sum);
    }
    let mut rng = Mt64::new(27_644_437);
    let mut out = Samples {
        pos: Vec::with_capacity(count),
        nrm: Vec::with_capacity(count),
        tri: Vec::with_capacity(count),
        total_area: sum,
    };
    if mesh.tris.is_empty() {
        return out;
    }
    for _ in 0..count {
        let (rx, ry, rz) = (rng.real(), rng.real(), rng.real());
        let t_sample = rx * f64::from(sum);
        let t = cumulative
            .partition_point(|&c| f64::from(c) <= t_sample)
            .min(mesh.tris.len() - 1);
        let sq_u = ry.sqrt() as f32;
        let v = rz as f32;
        let [a, b, c] = mesh.corners(t);
        let p = add(
            add(mul(a, 1.0 - sq_u), mul(b, sq_u * (1.0 - v))),
            mul(c, v * sq_u),
        );
        out.pos.push(p);
        out.nrm.push(unit(cross(sub(b, a), sub(c, b))));
        out.tri.push(t);
    }
    out
}

/// A bounding volume hierarchy over a triangle mesh for first-hit ray queries.
pub(crate) struct Bvh {
    mesh: Soup,
    nodes: Vec<Node>,
    order: Vec<u32>,
    /// Per slot of `order`, its place when the leaves are read right subtree first: the order a plain
    /// depth-first walk meets the triangles in, which settles hits at the same distance.
    rank: Vec<u32>,
    /// Per slot of `order`, its triangle's first corner and the two edges from it, as the hit test reads them.
    edges: Vec<[V3; 3]>,
    /// The inner nodes as `first_hit` reads them, the root's first.
    quads: Vec<Quad>,
}

struct Node {
    lo: V3,
    hi: V3,
    /// Leaf: first triangle slot and count; inner: left child index and 0 (the right child follows
    /// the left subtree's root at `right`).
    a: u32,
    n: u32,
    right: u32,
}

/// The children of two levels of the tree side by side, so a step of the walk reads one entry: an inner node's
/// grandchildren, with a leaf child standing for itself (two to four in all). Lane `k` holds child `k`: its box,
/// axis by axis, and the index of its own entry (an inner child, count 0) or its first triangle slot and count (a
/// leaf). A walk takes half the steps of one through the binary tree and sorts the children it keeps by distance.
struct Quad {
    lo: [[f32; 4]; 3],
    hi: [[f32; 4]; 3],
    at: [u32; 4],
    n: [u32; 4],
    len: usize,
}

impl Quad {
    /// Where the ray enters and leaves each child's box: the slab test of [`Bvh::slab`], lane by lane.
    fn slabs(&self, o: V3, inv: V3) -> ([f32; 4], [f32; 4]) {
        let (mut t0, mut t1) = ([0.0f32; 4], [f32::INFINITY; 4]);
        for axis in 0..3 {
            let (lo, hi, oa, ia) = (self.lo[axis], self.hi[axis], o[axis], inv[axis]);
            for lane in 0..4 {
                let (a, b) = ((lo[lane] - oa) * ia, (hi[lane] - oa) * ia);
                let (near, far) = if a < b { (a, b) } else { (b, a) };
                t0[lane] = t0[lane].max(near);
                t1[lane] = t1[lane].min(far);
            }
        }
        (t0, t1)
    }
}

/// The entries the walk reads for the inner nodes of `nodes`, the root's first (none when the root is a leaf).
fn quads(nodes: &[Node]) -> Vec<Quad> {
    let mut out: Vec<Quad> = Vec::new();
    // Inner nodes still to enter, with the lane of the entry that points to them.
    let mut todo: Vec<(u32, Option<(usize, usize)>)> = Vec::new();
    if nodes.first().is_some_and(|r| r.n == 0) {
        todo.push((0, None));
    }
    while let Some((x, from)) = todo.pop() {
        let Some(node) = nodes.get(x as usize) else {
            continue;
        };
        let id = out.len();
        if let Some((q, lane)) = from
            && let Some(slot) = out.get_mut(q).and_then(|e| e.at.get_mut(lane))
        {
            *slot = u32::try_from(id).unwrap_or(u32::MAX);
        }
        let mut quad = Quad {
            lo: [[0.0; 4]; 3],
            hi: [[0.0; 4]; 3],
            at: [0; 4],
            n: [0; 4],
            len: 0,
        };
        for c in [node.a, node.right] {
            let Some(child) = nodes.get(c as usize) else {
                continue;
            };
            let kids = if child.n > 0 {
                [Some(c), None]
            } else {
                [Some(child.a), Some(child.right)]
            };
            for k in kids.into_iter().flatten() {
                let (Some(kid), lane) = (nodes.get(k as usize), quad.len) else {
                    continue;
                };
                if lane >= 4 {
                    continue;
                }
                for axis in 0..3 {
                    quad.lo[axis][lane] = kid.lo[axis];
                    quad.hi[axis][lane] = kid.hi[axis];
                }
                if kid.n > 0 {
                    quad.at[lane] = kid.a;
                    quad.n[lane] = kid.n;
                } else {
                    todo.push((k, Some((id, lane))));
                }
                quad.len += 1;
            }
        }
        out.push(quad);
    }
    out
}

/// A node on the walk's stack: what [`Quad`] gives for it, and where the ray enters and leaves its box (uncapped).
#[derive(Clone, Copy, Default)]
pub(crate) struct Visit {
    at: u32,
    n: u32,
    t0: f32,
    far: f32,
}

impl Bvh {
    pub(crate) fn new(mesh: Soup) -> Self {
        let mut order: Vec<u32> = (0..mesh.tris.len() as u32).collect();
        let centers: Vec<V3> = (0..mesh.tris.len())
            .map(|t| {
                let [a, b, c] = mesh.corners(t);
                mul(add(add(a, b), c), 1.0 / 3.0)
            })
            .collect();
        let mut nodes = Vec::with_capacity(mesh.tris.len() / 2 + 1);
        if !order.is_empty() {
            let n = order.len();
            build(&mesh, &centers, &mut order, 0, n, &mut nodes);
        }
        let mut rank = vec![0u32; order.len()];
        let mut next = 0u32;
        let mut stack = vec![0u32];
        while let Some(i) = stack.pop() {
            let Some(node) = nodes.get(i as usize) else {
                continue;
            };
            if node.n > 0 {
                for s in node.a..node.a + node.n {
                    if let Some(r) = rank.get_mut(s as usize) {
                        *r = next;
                    }
                    next += 1;
                }
            } else {
                stack.push(node.a);
                stack.push(node.right);
            }
        }
        let edges = order
            .iter()
            .map(|&t| {
                let [a, b, c] = mesh.corners(t as usize);
                [a, sub(b, a), sub(c, a)]
            })
            .collect();
        let quads = quads(&nodes);
        Self {
            mesh,
            nodes,
            order,
            rank,
            edges,
            quads,
        }
    }

    /// Where the ray enters and leaves the box `lo hi` (the slab test).
    fn slab(lo: V3, hi: V3, o: V3, inv: V3) -> (f32, f32) {
        let (mut t0, mut t1) = (0.0f32, f32::INFINITY);
        for k in 0..3 {
            let (a, b) = ((lo[k] - o[k]) * inv[k], (hi[k] - o[k]) * inv[k]);
            let (near, far) = if a < b { (a, b) } else { (b, a) };
            t0 = t0.max(near);
            t1 = t1.min(far);
        }
        (t0, t1)
    }

    /// The nearest triangle the ray `o + t d` (t > 0) hits, and whether it is hit on its front
    /// (the ray runs against the triangle's normal). Of hits at the same distance, the one a depth-first walk
    /// of the right subtrees first meets wins (`rank`); the walk itself goes to the nearest child first, so far
    /// boxes are mostly cut off by a hit already found.
    ///
    /// The nearest child is taken next without going on the stack, and a child the ray misses (or meets beyond the
    /// best hit) is not put on it, since it would be dropped when taken off. The caller lends the stack, so rays
    /// cast one after another set up none of their own (an entry is always written before it is read).
    pub(crate) fn first_hit(&self, o: V3, d: V3, stack: &mut [Visit; 64]) -> Option<bool> {
        let root = self.nodes.first()?;
        let inv = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
        let mut best = f32::INFINITY;
        let mut best_rank = u32::MAX;
        let mut front = false;
        let mut hit = false;
        let mut sp = 0usize;
        let (t0, far) = Self::slab(root.lo, root.hi, o, inv);
        let mut next = Some(Visit {
            at: if root.n > 0 { root.a } else { 0 },
            n: root.n,
            t0,
            far,
        });
        loop {
            let v = if let Some(v) = next.take() {
                v
            } else {
                let Some(top) = sp.checked_sub(1) else { break };
                sp = top;
                stack[sp]
            };
            // The same test as entering the box with the far end capped at the best hit so far.
            if v.t0 > v.far.min(best) {
                continue;
            }
            if v.n > 0 {
                for s in v.at..v.at + v.n {
                    let Some(&[a, e1, e2]) = self.edges.get(s as usize) else {
                        continue;
                    };
                    // Moller-Trumbore; a positive determinant is a hit on the front.
                    let p = cross(d, e2);
                    let det = dot(e1, p);
                    if det.abs() < 1e-12 {
                        continue;
                    }
                    let id = 1.0 / det;
                    let s0 = sub(o, a);
                    let u = dot(s0, p) * id;
                    if !(0.0..=1.0).contains(&u) {
                        continue;
                    }
                    let q = cross(s0, e1);
                    let v = dot(d, q) * id;
                    if v < 0.0 || u + v > 1.0 {
                        continue;
                    }
                    let t = dot(e2, q) * id;
                    let rank = self.rank.get(s as usize).copied().unwrap_or(u32::MAX);
                    // An exact tie is what the rank settles.
                    #[allow(clippy::float_cmp, reason = "hits at exactly the same distance")]
                    let tie = t == best;
                    if t > 1e-6 && (t < best || (tie && rank < best_rank)) {
                        best = t;
                        best_rank = rank;
                        front = det > 0.0;
                        hit = true;
                    }
                }
            } else if let Some(q) = self.quads.get(v.at as usize) {
                let (t0, t1) = q.slabs(o, inv);
                // The children the ray meets before the best hit so far, nearest first (a later step would drop
                // the others, since the best hit only comes nearer).
                let mut kids = [Visit::default(); 4];
                let mut m = 0usize;
                for lane in 0..q.len.min(4) {
                    let (a, b) = (t0[lane], t1[lane]);
                    if a > b || a > best {
                        continue;
                    }
                    let mut j = m;
                    while j > 0 && kids[j - 1].t0 > a {
                        kids[j] = kids[j - 1];
                        j -= 1;
                    }
                    kids[j] = Visit {
                        at: q.at[lane],
                        n: q.n[lane],
                        t0: a,
                        far: b,
                    };
                    m += 1;
                }
                if let Some((&first, rest)) = kids.get(..m).and_then(<[Visit]>::split_first) {
                    for &later in rest.iter().rev() {
                        if sp < stack.len() {
                            stack[sp] = later;
                            sp += 1;
                        }
                    }
                    next = Some(first);
                }
            }
        }
        hit.then_some(front)
    }
}

impl Bvh {
    /// Every triangle the ray hits (t > 0), nearest first, with the sign of the ray against its normal
    /// (positive: the ray leaves through the face).
    pub(crate) fn all_hits(&self, o: V3, d: V3) -> Vec<(f32, usize, f32)> {
        let mut out: Vec<(f32, usize, f32)> = Vec::new();
        if self.nodes.is_empty() {
            return out;
        }
        let inv = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
        let mut stack = [0u32; 64];
        let mut sp = 1usize;
        while sp > 0 {
            sp -= 1;
            let Some(node) = self.nodes.get(stack[sp] as usize) else {
                continue;
            };
            let (mut t0, mut t1) = (0.0f32, f32::INFINITY);
            for k in 0..3 {
                let (a, b) = ((node.lo[k] - o[k]) * inv[k], (node.hi[k] - o[k]) * inv[k]);
                let (near, far) = if a < b { (a, b) } else { (b, a) };
                t0 = t0.max(near);
                t1 = t1.min(far);
            }
            if t0 > t1 {
                continue;
            }
            if node.n > 0 {
                for s in node.a..node.a + node.n {
                    let Some(&tri) = self.order.get(s as usize) else {
                        continue;
                    };
                    let [a, b, c] = self.mesh.corners(tri as usize);
                    let (e1, e2) = (sub(b, a), sub(c, a));
                    let p = cross(d, e2);
                    let det = dot(e1, p);
                    if det.abs() < 1e-12 {
                        continue;
                    }
                    let id = 1.0 / det;
                    let s0 = sub(o, a);
                    let u = dot(s0, p) * id;
                    if !(0.0..=1.0).contains(&u) {
                        continue;
                    }
                    let q = cross(s0, e1);
                    let v = dot(d, q) * id;
                    if v < 0.0 || u + v > 1.0 {
                        continue;
                    }
                    let t = dot(e2, q) * id;
                    if t > 1e-6 {
                        // det > 0: the ray runs against the normal (enters); the sign is n . d.
                        out.push((t, tri as usize, if det > 0.0 { -1.0 } else { 1.0 }));
                    }
                }
            } else if sp + 2 <= stack.len() {
                stack[sp] = node.a;
                stack[sp + 1] = node.right;
                sp += 2;
            }
        }
        crate::sorting::sort_by(&mut out, |x, y| x.0.total_cmp(&y.0));
        out
    }
}

fn build(mesh: &Soup, centers: &[V3], order: &mut [u32], lo: usize, hi: usize, nodes: &mut Vec<Node>) -> u32 {
    let mut bmin = [f32::MAX; 3];
    let mut bmax = [f32::MIN; 3];
    let mut cmin = [f32::MAX; 3];
    let mut cmax = [f32::MIN; 3];
    for &t in order.get(lo..hi).unwrap_or(&[]) {
        for p in mesh.corners(t as usize) {
            for k in 0..3 {
                if let (Some(a), Some(b), Some(&v)) = (bmin.get_mut(k), bmax.get_mut(k), p.get(k)) {
                    *a = a.min(v);
                    *b = b.max(v);
                }
            }
        }
        let c = centers.get(t as usize).copied().unwrap_or([0.0; 3]);
        for k in 0..3 {
            if let (Some(a), Some(b), Some(&v)) = (cmin.get_mut(k), cmax.get_mut(k), c.get(k)) {
                *a = a.min(v);
                *b = b.max(v);
            }
        }
    }
    let id = nodes.len() as u32;
    nodes.push(Node {
        lo: bmin,
        hi: bmax,
        a: lo as u32,
        n: (hi - lo) as u32,
        right: 0,
    });
    if hi - lo <= 4 {
        return id;
    }
    let axis = (0..3)
        .max_by(|&x, &y| {
            let (dx, dy) = (cmax[x] - cmin[x], cmax[y] - cmin[y]);
            dx.total_cmp(&dy)
        })
        .unwrap_or(0);
    if let Some(slice) = order.get_mut(lo..hi) {
        crate::sorting::sort_by(slice, |&p, &q| {
            let cp = centers.get(p as usize).map_or(0.0, |c| c[axis]);
            let cq = centers.get(q as usize).map_or(0.0, |c| c[axis]);
            cp.total_cmp(&cq)
        });
    }
    let mid = lo + (hi - lo) / 2;
    let left = build(mesh, centers, order, lo, mid, nodes);
    let right = build(mesh, centers, order, mid, hi, nodes);
    if let Some(n) = nodes.get_mut(id as usize) {
        n.a = left;
        n.n = 0;
        n.right = right;
    }
    id
}

/// A sample frame around a normal, as Orca's `Frame::set_from_z`.
fn frame(z: V3) -> [V3; 3] {
    let z = unit(z);
    let x0 = if z[0].abs() > 0.99 {
        [0.0, 1.0, 0.0]
    } else {
        [1.0, 0.0, 0.0]
    };
    let y = unit(cross(z, x0));
    let x = cross(y, z);
    [x, y, z]
}

/// The 25 directions over the hemisphere (`sample_hemisphere_uniform` on a 5 by 5 grid).
fn directions() -> Vec<V3> {
    let n = 5usize;
    let step = 1.0 / n as f32;
    let mut out = Vec::with_capacity(n * n);
    for xi in 0..n {
        let sx = xi as f32 * step + step / 2.0;
        for yi in 0..n {
            let sy = yi as f32 * step + step / 2.0;
            let t1 = 2.0 * std::f32::consts::PI * sx;
            let t2 = 2.0 * (sy - sy * sy).sqrt();
            out.push([
                crate::seamplan::cos32(t1) * t2,
                crate::seamplan::sin32(t1) * t2,
                (1.0 - 2.0 * sy).abs(),
            ]);
        }
    }
    out
}

/// What the visibility of a sample needs: the mesh in its tree and the directions of the rays.
pub(crate) struct Rays {
    bvh: Bvh,
    dirs: Vec<V3>,
    aligned_back: bool,
    /// The first triangle of the negative volumes, when there are any.
    negative_from: Option<usize>,
}

impl Rays {
    pub(crate) fn new(mesh: Soup, aligned_back: bool, negative_from: Option<usize>) -> Self {
        Self {
            bvh: Bvh::new(mesh),
            dirs: directions(),
            aligned_back,
            negative_from,
        }
    }

    /// Orca `raycast_visibility` for sample `i`: 1 minus a 25th for every ray from the sample that hits the
    /// front of the model (plus, for `aligned_back`, a term that favors samples facing away from the front of
    /// the plate).
    fn sample(&self, samples: &Samples, i: usize) -> f32 {
        let (Some(&center), Some(&normal)) = (samples.pos.get(i), samples.nrm.get(i)) else {
            return 1.0;
        };
        let step = 1.0 / self.dirs.len() as f32;
        let mut v = 1.0f32;
        if self.aligned_back {
            v += f32::midpoint(dot(normal, [0.0, -1.0, 0.0]), 1.2).clamp(0.0, 1.0);
        }
        let f = frame(normal);
        let from_negative = self
            .negative_from
            .is_some_and(|n| samples.tri.get(i).is_some_and(|t| *t >= n));
        let origin = if from_negative {
            sub(center, mul(normal, 0.01))
        } else {
            add(center, mul(normal, 0.01))
        };
        let mut stack = [Visit::default(); 64];
        for d in &self.dirs {
            let mut world = add(add(mul(f[0], d[0]), mul(f[1], d[1])), mul(f[2], d[2]));
            if from_negative {
                world = mul(world, -1.0);
            }
            match self.negative_from {
                None => {
                    if self.bvh.first_hit(origin, world, &mut stack) == Some(true) {
                        v -= step;
                    }
                }
                Some(neg) => {
                    // Walk the hits from the far end, where the ray is known to be outside everything:
                    // entering or leaving a model counts one way, a negative volume the other; the ray
                    // sees nothing of the model when they cancel.
                    let hits = self.bvh.all_hits(origin, world);
                    if !hits.is_empty() {
                        let mut counter = 0i32;
                        for &(_, tri, sign) in hits.iter().rev() {
                            let s = if sign > 0.0 { 1 } else { -1 };
                            if tri >= neg {
                                counter -= s;
                            } else {
                                counter += s;
                            }
                        }
                        if counter == 0 {
                            v -= step;
                        }
                    }
                }
            }
        }
        v
    }
}

/// The visibility of every sample, as [`Field`] works each out.
#[cfg(test)]
fn visibility(mesh: &Soup, samples: &Samples, aligned_back: bool, negative_from: Option<usize>) -> Vec<f32> {
    let rays = Rays::new(mesh.clone(), aligned_back, negative_from);
    (0..samples.pos.len()).map(|i| rays.sample(samples, i)).collect()
}

/// The samples and their visibility, searchable by position. A sample's visibility is worked out the first
/// time a point within the radius asks for it: the seam candidates sit on the wall corners and curves, and on a
/// model with large flat faces more than half the samples lie farther than the radius from all of them.
pub(crate) struct Field {
    samples: Samples,
    rays: Rays,
    /// Per sample, 0 until its visibility is known, then its bits with bit 32 set. Two threads that ask for
    /// the same new sample at once both work it out, to the same value.
    vis: Vec<std::sync::atomic::AtomicU64>,
    radius: f32,
    cell: HashMap<(i32, i32, i32), Vec<u32>, CellHash>,
}

/// A multiply and rotate hash for grid cells (the keys are small integers from our own data, and lookups
/// are hot), in place of the standard keyed hash. Only lookups read the map, so the order is never seen.
#[derive(Default, Clone, Copy)]
struct CellHash;

#[derive(Default)]
struct CellHasher(u64);

impl std::hash::BuildHasher for CellHash {
    type Hasher = CellHasher;
    fn build_hasher(&self) -> CellHasher {
        CellHasher(0)
    }
}

impl std::hash::Hasher for CellHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u32(u32::from(b));
        }
    }
    fn write_u32(&mut self, v: u32) {
        self.0 = (self.0.rotate_left(5) ^ u64::from(v)).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    fn write_i32(&mut self, v: i32) {
        self.write_u32(v.cast_unsigned());
    }
}

impl Field {
    #[allow(clippy::cast_possible_truncation, reason = "grid cells")]
    pub(crate) fn new(samples: Samples, rays: Rays) -> Self {
        // The radius with 90 percent odds of holding at least 4 samples (Orca's exponential argument).
        let density = samples.pos.len() as f32 / samples.total_area.max(1e-6);
        let area = 4.0 / (-(crate::seamplan::ln32(0.9)) * density);
        let radius = (area / std::f32::consts::PI).sqrt();
        let mut cell: HashMap<(i32, i32, i32), Vec<u32>, CellHash> = HashMap::default();
        let key = |p: V3| {
            (
                (p[0] / radius).floor() as i32,
                (p[1] / radius).floor() as i32,
                (p[2] / radius).floor() as i32,
            )
        };
        for (i, &p) in samples.pos.iter().enumerate() {
            cell.entry(key(p)).or_default().push(i as u32);
        }
        let vis = (0..samples.pos.len())
            .map(|_| std::sync::atomic::AtomicU64::new(0))
            .collect();
        Self {
            samples,
            rays,
            vis,
            radius,
            cell,
        }
    }

    /// The visibility of sample `i`, worked out on first use.
    fn visibility(&self, i: usize) -> f32 {
        use std::sync::atomic::Ordering::Relaxed;
        let Some(slot) = self.vis.get(i) else { return 1.0 };
        let known = slot.load(Relaxed);
        if known != 0 {
            return f32::from_bits(known as u32);
        }
        let v = self.rays.sample(&self.samples, i);
        slot.store((1 << 32) | u64::from(v.to_bits()), Relaxed);
        v
    }

    /// Orca `calculate_point_visibility`.
    #[allow(clippy::cast_possible_truncation, reason = "grid cells")]
    pub(crate) fn at(&self, p: V3) -> f32 {
        let r = self.radius;
        let (cx, cy, cz) = (
            (p[0] / r).floor() as i32,
            (p[1] / r).floor() as i32,
            (p[2] / r).floor() as i32,
        );
        let (mut total, mut weight) = (0.0f32, 0.0f32);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let Some(list) = self.cell.get(&(cx + dx, cy + dy, cz + dz)) else {
                        continue;
                    };
                    for &i in list {
                        let (Some(&sp), Some(&sn)) =
                            (self.samples.pos.get(i as usize), self.samples.nrm.get(i as usize))
                        else {
                            continue;
                        };
                        let d = sub(p, sp);
                        let dist = norm(d);
                        if dist > r {
                            continue;
                        }
                        let sv = self.visibility(i as usize);
                        let w = (r - dot(d, sn).abs()) + (r - dist);
                        total += w * sv;
                        weight += w;
                    }
                }
            }
        }
        if weight > 0.0 { total / weight } else { 1.0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube(s: f32) -> Soup {
        let v = |x: f32, y: f32, z: f32| [x * s, y * s, z * s];
        Soup {
            verts: vec![
                v(0., 0., 0.),
                v(1., 0., 0.),
                v(1., 1., 0.),
                v(0., 1., 0.),
                v(0., 0., 1.),
                v(1., 0., 1.),
                v(1., 1., 1.),
                v(0., 1., 1.),
            ],
            tris: vec![
                [0, 2, 1],
                [0, 3, 2],
                [4, 5, 6],
                [4, 6, 7],
                [0, 1, 5],
                [0, 5, 4],
                [1, 2, 6],
                [1, 6, 5],
                [2, 3, 7],
                [2, 7, 6],
                [3, 0, 4],
                [3, 4, 7],
            ],
        }
    }

    #[test]
    fn the_generator_is_mt19937_64() {
        // The 10000th output of a default-seeded std::mt19937_64 is 9981545732273789042.
        let mut g = Mt64::new(5489);
        let mut last = 0;
        for _ in 0..10_000 {
            last = g.next();
        }
        assert_eq!(last, 9_981_545_732_273_789_042);
    }

    #[test]
    fn a_convex_surface_sees_everything() {
        let mesh = cube(10.0);
        let s = sample(&mesh, 500);
        assert!((s.total_area - 600.0).abs() < 1.0);
        let vis = visibility(&mesh, &s, false, None);
        assert!(vis.iter().all(|v| (*v - 1.0).abs() < 1e-5), "{vis:?}");
    }

    #[test]
    fn a_hidden_slot_sees_less() {
        // Two cubes with a 1 mm gap: the facing sides see little.
        let mut a = cube(10.0);
        let b = cube(10.0);
        let off = a.verts.len() as u32;
        a.verts.extend(b.verts.iter().map(|v| [v[0] + 11.0, v[1], v[2]]));
        a.tris
            .extend(b.tris.iter().map(|t| [t[0] + off, t[1] + off, t[2] + off]));
        let s = sample(&a, 2000);
        let vis = visibility(&a, &s, false, None);
        let mean = |f: &dyn Fn(V3) -> bool| {
            let v: Vec<f32> = s
                .pos
                .iter()
                .zip(&vis)
                .filter(|(p, _)| f(**p))
                .map(|(_, v)| *v)
                .collect();
            v.iter().sum::<f32>() / v.len() as f32
        };
        let inner = mean(&|p| (p[0] - 10.0).abs() < 1e-3 || (p[0] - 11.0).abs() < 1e-3);
        let outer = mean(&|p| p[0].abs() < 1e-3);
        assert!(inner < outer - 0.3, "{inner} {outer}");
    }

    #[test]
    fn a_negative_volume_opens_the_surface_it_cuts() {
        // A 10 mm cube with a 4 mm cube cut into its top. The floor of the pocket is a face of the model
        // looking up at open air: fully visible; the pocket's own walls see only the opening.
        let mut m = cube(10.0);
        let pocket_floor_z = 6.0f32;
        let neg = Soup {
            verts: vec![
                [3.0, 3.0, pocket_floor_z],
                [7.0, 3.0, pocket_floor_z],
                [7.0, 7.0, pocket_floor_z],
                [3.0, 7.0, pocket_floor_z],
                [3.0, 3.0, 12.0],
                [7.0, 3.0, 12.0],
                [7.0, 7.0, 12.0],
                [3.0, 7.0, 12.0],
            ],
            tris: cube(1.0).tris,
        };
        let from = m.tris.len();
        let base = m.verts.len() as u32;
        m.verts.extend(neg.verts.iter().copied());
        m.tris
            .extend(neg.tris.iter().map(|t| [t[0] + base, t[1] + base, t[2] + base]));
        let s = sample(&m, 2000);
        let vis = visibility(&m, &s, false, Some(from));
        assert!(vis.iter().all(|v| (-1e-5..=1.0 + 1e-5).contains(v)));
    }

    #[test]
    fn collapse_reaches_the_target_and_keeps_the_shape() {
        // A fine grid-like slab: 2 x 20 x 20 quads.
        let n = 20u32;
        let mut verts = Vec::new();
        let mut tris = Vec::new();
        for i in 0..=n {
            for j in 0..=n {
                verts.push([i as f32, j as f32, 0.0]);
            }
        }
        for i in 0..n {
            for j in 0..n {
                let a = i * (n + 1) + j;
                let (b, c, d) = (a + 1, a + n + 1, a + n + 2);
                tris.push([a, d, b]);
                tris.push([a, c, d]);
            }
        }
        let mut m = Soup { verts, tris };
        let before = m.tris.len();
        collapse(&mut m, 200);
        assert!(m.tris.len() <= 210 && m.tris.len() < before, "{}", m.tris.len());
        assert!(m.verts.iter().all(|v| v[2] == 0.0));
    }
}
