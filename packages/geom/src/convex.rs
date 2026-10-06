// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! booleans between a closed mesh and a planar region
// vertex and triangle indices are built and checked in this module
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::mesh::{Aabb, TriMesh, weld_tolerance};
use crate::poly2d::{self, Polygon};
use crate::vec3::{self, Frame, Plane, V2, V3};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct ConvexSolid {
    pub planes: Vec<Plane>,
}

impl ConvexSolid {
    pub fn contains(&self, p: V3) -> bool {
        self.planes.iter().all(|pl| pl.distance(p) < 0.0)
    }

    pub fn prism(frame: &Frame, ring: &[V2], h0: f64, h1: f64) -> Result<Self> {
        if ring.len() < 3 || h1 <= h0 {
            return Err(Error::invalid("prism", "needs 3 or more points and h1 > h0"));
        }
        let ccw = poly2d::signed_area(ring) > 0.0;
        let mut planes = Vec::with_capacity(ring.len() + 2);
        let n = ring.len();
        for i in 0..n {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let out2 = if ccw { [dy, -dx] } else { [-dy, dx] };
            let normal = vec3::add(vec3::scale(frame.u, out2[0]), vec3::scale(frame.v, out2[1]));
            if let Some(p) = Plane::new(frame.at(a, 0.0), normal) {
                planes.push(p);
            }
        }
        planes.push(Plane {
            normal: frame.w,
            offset: vec3::dot(frame.w, frame.at([0.0, 0.0], h1)),
        });
        planes.push(Plane {
            normal: vec3::scale(frame.w, -1.0),
            offset: -vec3::dot(frame.w, frame.at([0.0, 0.0], h0)),
        });
        Ok(Self { planes })
    }

    pub fn cylinder(frame: &Frame, r: f64, h0: f64, h1: f64, segments: usize) -> Result<Self> {
        Self::prism(frame, &poly2d::circle([0.0, 0.0], r, segments), h0, h1)
    }

    pub fn faces(&self, center: V3, size: f64) -> Vec<Face> {
        let mut out = Vec::new();
        for (i, pl) in self.planes.iter().enumerate() {
            let mut poly = big_square(pl, center, size);
            for (j, other) in self.planes.iter().enumerate() {
                if i != j {
                    poly = clip_polygon(&poly, other);
                }
            }
            if poly.len() >= 3 {
                out.push(Face {
                    plane: *pl,
                    rings: vec![poly],
                });
            }
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Face {
    pub plane: Plane,
    pub rings: Vec<Vec<V3>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Csg {
    Solid(ConvexSolid),
    Not(Box<Csg>),
    And(Vec<Csg>),
    Or(Vec<Csg>),
}

impl Csg {
    fn contains_with(&self, dist: &dyn Fn(&Plane) -> f64) -> bool {
        match self {
            Csg::Solid(s) => s.planes.iter().all(|p| dist(p) < 0.0),
            Csg::Not(c) => !c.contains_with(dist),
            Csg::And(cs) => cs.iter().all(|c| c.contains_with(dist)),
            Csg::Or(cs) => cs.iter().any(|c| c.contains_with(dist)),
        }
    }

    pub fn contains(&self, p: V3) -> bool {
        self.contains_with(&|pl| pl.distance(p))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Region {
    pub faces: Vec<Face>,
    pub csg: Csg,
}

impl Region {
    pub fn halfspace(plane: Plane, bounds: &Aabb) -> Self {
        let (c, s) = cover(bounds);
        Self {
            faces: vec![Face {
                plane,
                rings: vec![big_square(&plane, c, s)],
            }],
            csg: Csg::Solid(ConvexSolid { planes: vec![plane] }),
        }
    }

    pub fn complement(solid: &ConvexSolid, bounds: &Aabb) -> Self {
        let (c, s) = cover(bounds);
        let faces = solid.faces(c, s).into_iter().map(Face::flipped).collect();
        Self {
            faces,
            csg: Csg::Not(Box::new(Csg::Solid(solid.clone()))),
        }
    }

    pub fn cut_with(base: Plane, bounds: &Aabb, add: &[ConvexSolid], remove: &[ConvexSolid]) -> Self {
        let (c, s) = cover(bounds);
        let mut base_face = Face {
            plane: base,
            rings: vec![big_square(&base, c, s)],
        };
        let mut faces = Vec::new();
        for solid in add.iter().chain(remove) {
            let mut foot = big_square(&base, c, s * 0.5);
            for p in &solid.planes {
                foot = clip_polygon(&foot, p);
            }
            if foot.len() >= 3 {
                foot.reverse();
                base_face.rings.push(foot);
            }
        }
        faces.push(base_face);
        let above = base.flipped();
        for solid in add {
            for f in solid.faces(c, s) {
                let ring = clip_polygon(&f.rings[0], &above);
                if ring.len() >= 3 {
                    faces.push(Face {
                        plane: f.plane,
                        rings: vec![ring],
                    });
                }
            }
        }
        for solid in remove {
            for f in solid.faces(c, s) {
                let ring = clip_polygon(&f.rings[0], &base);
                if ring.len() >= 3 {
                    faces.push(
                        Face {
                            plane: f.plane,
                            rings: vec![ring],
                        }
                        .flipped(),
                    );
                }
            }
        }
        let mut union = vec![Csg::Solid(ConvexSolid { planes: vec![base] })];
        union.extend(add.iter().cloned().map(Csg::Solid));
        let mut all = vec![Csg::Or(union)];
        all.extend(remove.iter().cloned().map(|r| Csg::Not(Box::new(Csg::Solid(r)))));
        Self {
            faces,
            csg: Csg::And(all),
        }
    }
}

impl Face {
    #[must_use]
    pub fn flipped(self) -> Self {
        Self {
            plane: self.plane.flipped(),
            rings: self
                .rings
                .into_iter()
                .map(|mut r| {
                    r.reverse();
                    r
                })
                .collect(),
        }
    }
}

fn cover(bounds: &Aabb) -> (V3, f64) {
    (bounds.center(), bounds.diagonal().max(1.0) * 4.0)
}

fn big_square(plane: &Plane, center: V3, size: f64) -> Vec<V3> {
    let origin = vec3::sub(center, vec3::scale(plane.normal, plane.distance(center)));
    let f = Frame::from_normal(origin, plane.normal, None).unwrap_or(Frame::WORLD);
    poly2d::rect([-size, -size], [size, size])
        .into_iter()
        .map(|p| f.at(p, 0.0))
        .collect()
}

pub fn clip_polygon(poly: &[V3], plane: &Plane) -> Vec<V3> {
    let n = poly.len();
    let mut out = Vec::with_capacity(n + 1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let (da, db) = (plane.distance(a), plane.distance(b));
        if da <= 0.0 {
            out.push(a);
        }
        if (da < 0.0 && db > 0.0) || (da > 0.0 && db < 0.0) {
            out.push(vec3::lerp(a, b, da / (da - db)));
        }
    }
    out
}

pub fn subtract(mesh: &TriMesh, solid: &ConvexSolid) -> Result<TriMesh> {
    let Some(b) = mesh.bounds() else {
        return Ok(TriMesh::default());
    };
    intersect(mesh, &Region::complement(solid, &b))
}

pub fn intersect(mesh: &TriMesh, region: &Region) -> Result<TriMesh> {
    mesh.validate("boolean input")?;
    let Some(bounds) = mesh.bounds() else {
        return Ok(TriMesh::default());
    };
    let eps = weld_tolerance(Some(bounds)) * 10.0;
    let mut work = Imprint::new(mesh);
    // each plane only needs to split triangles near its faces: a triangle that
    // touches a face's box lies within one edge length of it
    let reach = work.max_edge() + eps;
    let mut planes: Vec<(Plane, Aabb)> = Vec::new();
    for f in &region.faces {
        let Some(fb) = ring_bounds(&f.rings) else {
            continue;
        };
        match planes.iter_mut().find(|(p, _)| same_plane(p, &f.plane, eps)) {
            Some((_, b)) => *b = union(b, &fb),
            None => planes.push((f.plane, fb)),
        }
    }
    for (p, b) in &planes {
        work.split(p, eps, Some(&grow(b, reach)));
    }
    Ok(extract(&work, mesh, region, eps))
}

pub(crate) fn split_by_plane(mesh: &TriMesh, plane: &Plane) -> Result<(TriMesh, TriMesh)> {
    mesh.validate("cut input")?;
    let Some(bounds) = mesh.bounds() else {
        return Ok((TriMesh::default(), TriMesh::default()));
    };
    let eps = weld_tolerance(Some(bounds)) * 10.0;
    let mut work = Imprint::new(mesh);
    work.split(plane, eps, None);
    Ok((
        extract(&work, mesh, &Region::halfspace(*plane, &bounds), eps),
        extract(&work, mesh, &Region::halfspace(plane.flipped(), &bounds), eps),
    ))
}

fn ring_bounds(rings: &[Vec<V3>]) -> Option<Aabb> {
    let mut it = rings.iter().flatten();
    let first = *it.next()?;
    let mut b = Aabb {
        min: first,
        max: first,
    };
    for p in it {
        b.min = std::array::from_fn(|k| b.min[k].min(p[k]));
        b.max = std::array::from_fn(|k| b.max[k].max(p[k]));
    }
    Some(b)
}

fn union(a: &Aabb, b: &Aabb) -> Aabb {
    Aabb {
        min: std::array::from_fn(|k| a.min[k].min(b.min[k])),
        max: std::array::from_fn(|k| a.max[k].max(b.max[k])),
    }
}

fn grow(a: &Aabb, r: f64) -> Aabb {
    Aabb {
        min: a.min.map(|v| v - r),
        max: a.max.map(|v| v + r),
    }
}

fn same_plane(a: &Plane, b: &Plane, eps: f64) -> bool {
    vec3::dot(a.normal, b.normal) > 1.0 - 1e-12 && (a.offset - b.offset).abs() <= eps
}

struct Imprint {
    pos: Vec<V3>,
    tris: Vec<[u32; 3]>,
}

impl Imprint {
    fn new(mesh: &TriMesh) -> Self {
        Self {
            pos: mesh.positions.clone(),
            tris: mesh.triangles.clone(),
        }
    }

    fn max_edge(&self) -> f64 {
        self.tris
            .iter()
            .flat_map(|t| (0..3).map(move |k| (t[k], t[(k + 1) % 3])))
            .map(|(a, b)| vec3::len(vec3::sub(self.pos[a as usize], self.pos[b as usize])))
            .fold(0.0, f64::max)
    }

    #[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
    fn split(&mut self, plane: &Plane, eps: f64, limit: Option<&Aabb>) {
        let d: Vec<f64> = self
            .pos
            .iter()
            .map(|&p| {
                let d = plane.distance(p);
                if d.abs() <= eps { 0.0 } else { d }
            })
            .collect();
        let mut cache: HashMap<(u32, u32), u32> = HashMap::new();
        let mut out = Vec::with_capacity(self.tris.len() + self.tris.len() / 8);
        let pos = &mut self.pos;
        let allowed = |pos: &[V3], a: u32, b: u32| {
            limit.is_none_or(|l| {
                let (p, q) = (pos[a as usize], pos[b as usize]);
                (0..3).all(|k| p[k].min(q[k]) <= l.max[k] && p[k].max(q[k]) >= l.min[k])
            })
        };
        let mut cross = |pos: &mut Vec<V3>, a: u32, b: u32| -> u32 {
            let key = (a.min(b), a.max(b));
            *cache.entry(key).or_insert_with(|| {
                let (i, j) = key;
                let (da, db) = (d[i as usize], d[j as usize]);
                let p = vec3::lerp(pos[i as usize], pos[j as usize], da / (da - db));
                pos.push(p);
                (pos.len() - 1) as u32
            })
        };
        for &t in &self.tris {
            let s = t.map(|i| d[i as usize].partial_cmp(&0.0).map_or(0, |o| o as i8));
            let has_neg = s.contains(&-1);
            let has_pos = s.contains(&1);
            if !(has_neg && has_pos) {
                out.push(t);
                continue;
            }
            let k = (0..3)
                .find(|&k| s[k] == 0 || (s[(k + 1) % 3] == s[(k + 2) % 3] && s[(k + 1) % 3] != 0))
                .unwrap_or(0);
            let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
            if s[k] == 0 {
                if allowed(pos, b, c) {
                    let x = cross(pos, b, c);
                    out.push([a, b, x]);
                    out.push([a, x, c]);
                } else {
                    out.push(t);
                }
                continue;
            }
            match (allowed(pos, a, b), allowed(pos, c, a)) {
                (true, true) => {
                    let xab = cross(pos, a, b);
                    let xca = cross(pos, c, a);
                    out.push([a, xab, xca]);
                    out.push([xab, b, c]);
                    out.push([xab, c, xca]);
                }
                (true, false) => {
                    let xab = cross(pos, a, b);
                    out.push([a, xab, c]);
                    out.push([xab, b, c]);
                }
                (false, true) => {
                    let xca = cross(pos, c, a);
                    out.push([a, b, xca]);
                    out.push([xca, b, c]);
                }
                (false, false) => out.push(t),
            }
        }
        self.tris = out;
    }
}

fn extract(work: &Imprint, original: &TriMesh, region: &Region, eps: f64) -> TriMesh {
    let delta = eps * 0.1;
    let snap = |d: f64| if d.abs() <= eps { 0.0 } else { d };
    let mut kept: Vec<[u32; 3]> = Vec::with_capacity(work.tris.len());
    for &t in &work.tris {
        let [a, b, c] = t.map(|i| work.pos[i as usize]);
        let Some(n) = vec3::normalize(vec3::tri_normal(a, b, c)) else {
            continue;
        };
        let dist = |pl: &Plane| {
            (snap(pl.distance(a)) + snap(pl.distance(b)) + snap(pl.distance(c))) / 3.0
                - delta * vec3::dot(n, pl.normal)
        };
        if region.csg.contains_with(&dist) {
            kept.push(t);
        }
    }
    let mut directed: HashMap<(u32, u32), u32> = HashMap::with_capacity(kept.len() * 3);
    for t in &kept {
        for k in 0..3 {
            *directed.entry((t[k], t[(k + 1) % 3])).or_insert(0) += 1;
        }
    }
    let frames: Vec<FaceFrame> = region.faces.iter().map(FaceFrame::new).collect();
    let mut per_face: Vec<Vec<(u32, u32)>> = vec![Vec::new(); region.faces.len()];
    for t in &kept {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            if directed.contains_key(&(b, a)) {
                continue;
            }
            let (pa, pb) = (work.pos[a as usize], work.pos[b as usize]);
            let mid = vec3::lerp(pa, pb, 0.5);
            let face = frames.iter().position(|f| {
                f.plane.distance(pa).abs() <= eps
                    && f.plane.distance(pb).abs() <= eps
                    && f.contains(f.frame.project(mid), eps)
            });
            if let Some(fi) = face {
                per_face[fi].push((b, a));
            }
        }
    }
    let mut out = TriMesh {
        positions: work.pos.clone(),
        triangles: kept,
        faces: None,
    };
    for (fi, edges) in per_face.iter().enumerate() {
        if let Some(loops) = walk_face(&frames[fi], edges, &mut out, original, eps) {
            cap_loops(&frames[fi], loops, &mut out);
        }
    }
    out.subset(&out.triangles).weld(eps * 0.5)
}

struct FaceFrame {
    plane: Plane,
    frame: Frame,
    rings3: Vec<Vec<V3>>,
    rings2: Vec<Vec<V2>>,
    arc: Vec<(Vec<f64>, f64)>,
}

impl FaceFrame {
    fn new(f: &Face) -> Self {
        let origin = f
            .rings
            .first()
            .and_then(|r| r.first())
            .copied()
            .unwrap_or(f.plane.origin());
        let frame = Frame::from_normal(origin, f.plane.normal, None).unwrap_or(Frame::WORLD);
        let rings2: Vec<Vec<V2>> = f
            .rings
            .iter()
            .map(|r| r.iter().map(|&p| frame.project(p)).collect())
            .collect();
        let arc = rings2
            .iter()
            .map(|r| {
                let mut acc = Vec::with_capacity(r.len());
                let mut s = 0.0;
                for i in 0..r.len() {
                    acc.push(s);
                    let (a, b) = (r[i], r[(i + 1) % r.len()]);
                    s += (b[0] - a[0]).m_hypot(b[1] - a[1]);
                }
                (acc, s)
            })
            .collect();
        Self {
            plane: f.plane,
            frame,
            rings3: f.rings.clone(),
            rings2,
            arc,
        }
    }

    fn contains(&self, p: V2, eps: f64) -> bool {
        let Some(outer) = self.rings2.first() else {
            return false;
        };
        if self.on_boundary(p, eps).is_some() {
            return true;
        }
        poly2d::point_in_ring(p, outer) && !self.rings2[1..].iter().any(|h| poly2d::point_in_ring(p, h))
    }

    fn on_boundary(&self, p: V2, eps: f64) -> Option<(usize, f64)> {
        let mut best: Option<(f64, usize, f64)> = None;
        for (ri, r) in self.rings2.iter().enumerate() {
            let n = r.len();
            for i in 0..n {
                let (a, b) = (r[i], r[(i + 1) % n]);
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let l2 = dx * dx + dy * dy;
                if l2 <= 0.0 {
                    continue;
                }
                let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0);
                let q = [a[0] + dx * t, a[1] + dy * t];
                let d = (p[0] - q[0]).m_hypot(p[1] - q[1]);
                if d <= eps && best.is_none_or(|(bd, _, _)| d < bd) {
                    best = Some((d, ri, self.arc[ri].0[i] + t * l2.sqrt()));
                }
            }
        }
        best.map(|(_, r, s)| (r, s))
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "the chain, walk and ring steps share their maps"
)]
#[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
fn walk_face(
    f: &FaceFrame,
    edges: &[(u32, u32)],
    out: &mut TriMesh,
    original: &TriMesh,
    eps: f64,
) -> Option<Vec<Vec<u32>>> {
    let mut next: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut indeg: HashMap<u32, i64> = HashMap::new();
    for &(a, b) in edges {
        next.entry(a).or_default().push(b);
        *indeg.entry(b).or_insert(0) += 1;
        indeg.entry(a).or_insert(0);
    }
    let mut starts: Vec<u32> = next
        .iter()
        .filter(|(v, outs)| {
            i64::try_from(outs.len()).unwrap_or(i64::MAX) > indeg.get(v).copied().unwrap_or(0)
        })
        .map(|(v, _)| *v)
        .collect();
    starts.sort_unstable();
    let take = |v: u32, next: &mut HashMap<u32, Vec<u32>>| next.get_mut(&v).and_then(Vec::pop);
    let mut chains: Vec<Vec<u32>> = Vec::new();
    for s in starts {
        while let Some(first) = take(s, &mut next) {
            let mut chain = vec![s, first];
            let mut at = first;
            let mut guard = edges.len() + 1;
            while let Some(n) = take(at, &mut next) {
                chain.push(n);
                at = n;
                guard -= 1;
                if guard == 0 {
                    return None;
                }
            }
            chains.push(chain);
        }
    }
    let mut loops: Vec<Vec<u32>> = Vec::new();
    let mut keys: Vec<u32> = next.keys().copied().collect();
    keys.sort_unstable();
    for s in keys {
        while let Some(first) = take(s, &mut next) {
            let mut lp = vec![s];
            let mut at = first;
            let mut guard = edges.len() + 1;
            while at != s {
                lp.push(at);
                at = take(at, &mut next)?;
                guard -= 1;
                if guard == 0 {
                    return None;
                }
            }
            loops.push(lp);
        }
    }
    let locate = |pos: &[V3], v: u32| {
        let p = f.frame.project(pos[v as usize]);
        f.on_boundary(p, eps * 4.0)
    };
    let mut ends: Vec<Vec<(f64, bool, usize)>> = vec![Vec::new(); f.rings2.len()];
    for (ci, ch) in chains.iter().enumerate() {
        let (Some(&s), Some(&e)) = (ch.first(), ch.last()) else {
            return None;
        };
        let (Some((rs, ss)), Some((re, se))) = (locate(&out.positions, s), locate(&out.positions, e)) else {
            return None;
        };
        ends[rs].push((ss, true, ci));
        ends[re].push((se, false, ci));
    }
    for e in &mut ends {
        e.sort_by(|a, b| a.0.total_cmp(&b.0));
    }
    let mut corner_ix: HashMap<(usize, usize), u32> = HashMap::new();
    let mut used = vec![false; chains.len()];
    for c0 in 0..chains.len() {
        if used[c0] {
            continue;
        }
        let mut lp: Vec<u32> = Vec::new();
        let mut c = c0;
        loop {
            used[c] = true;
            lp.extend_from_slice(&chains[c]);
            let &last = chains[c].last()?;
            let (ring, s_exit) = locate(&out.positions, last)?;
            let list = &ends[ring];
            let total = f.arc[ring].1;
            let next_start = list
                .iter()
                .filter(|(_, is_start, _)| *is_start)
                .min_by(|a, b| {
                    let da = (a.0 - s_exit).rem_euclid(total);
                    let db = (b.0 - s_exit).rem_euclid(total);
                    da.total_cmp(&db)
                })
                .copied();
            let (s_entry, _, c2) = next_start?;
            let span = (s_entry - s_exit).rem_euclid(total);
            let corners = &f.arc[ring].0;
            let mut between: Vec<(f64, usize)> = corners
                .iter()
                .enumerate()
                .map(|(k, &sc)| ((sc - s_exit).rem_euclid(total), k))
                .filter(|&(off, _)| off > eps && off < span - eps)
                .collect();
            between.sort_by(|a, b| a.0.total_cmp(&b.0));
            for (_, k) in between {
                let ix = *corner_ix
                    .entry((ring, k))
                    .or_insert_with(|| out.push_vertex(f.rings3[ring][k]));
                lp.push(ix);
            }
            if c2 == c0 {
                break;
            }
            if used[c2] {
                return None;
            }
            c = c2;
        }
        lp.dedup();
        if lp.len() > 1 && lp.first() == lp.last() {
            lp.pop();
        }
        loops.push(lp);
    }
    for (ri, ring) in f.rings3.iter().enumerate() {
        if !ends[ri].is_empty() || ring.is_empty() {
            continue;
        }
        let probe = vec3::lerp(ring[0], ring[ring.len() / 2], 1e-3);
        if point_inside_mesh(original, probe) {
            let base = out.positions.len() as u32;
            out.positions.extend_from_slice(ring);
            loops.push((0..ring.len() as u32).map(|k| base + k).collect());
        }
    }
    Some(loops)
}

fn cap_loops(f: &FaceFrame, loops: Vec<Vec<u32>>, out: &mut TriMesh) {
    let rings: Vec<(Vec<V2>, Vec<u32>)> = loops
        .into_iter()
        .filter(|l| l.len() >= 3)
        .map(|l| {
            (
                l.iter()
                    .map(|&i| f.frame.project(out.positions[i as usize]))
                    .collect(),
                l,
            )
        })
        .collect();
    for (poly, ids) in nest_indexed(&rings) {
        let Ok(tris) = poly2d::triangulate(&poly) else {
            continue;
        };
        for t in tris {
            out.triangles.push(t.map(|k| ids[k as usize]));
        }
    }
}

fn nest_indexed(rings: &[(Vec<V2>, Vec<u32>)]) -> Vec<(Polygon, Vec<u32>)> {
    let n = rings.len();
    let areas: Vec<f64> = rings.iter().map(|r| poly2d::signed_area(&r.0).abs()).collect();
    let probes: Vec<V2> = rings.iter().map(|r| poly2d::interior_point(&r.0)).collect();
    let mut parent = vec![usize::MAX; n];
    for i in 0..n {
        for j in 0..n {
            if i != j
                && areas[j] > areas[i]
                && poly2d::point_in_ring(probes[i], &rings[j].0)
                && (parent[i] == usize::MAX || areas[j] < areas[parent[i]])
            {
                parent[i] = j;
            }
        }
    }
    let depth = |mut i: usize| {
        let mut d = 0;
        while parent[i] != usize::MAX && d <= n {
            d += 1;
            i = parent[i];
        }
        d
    };
    let mut slot = vec![usize::MAX; n];
    let mut out: Vec<(Polygon, Vec<u32>)> = Vec::new();
    for i in 0..n {
        if depth(i).is_multiple_of(2) {
            let (mut pts, mut ids) = rings[i].clone();
            if poly2d::signed_area(&pts) < 0.0 {
                pts.reverse();
                ids.reverse();
            }
            slot[i] = out.len();
            out.push((
                Polygon {
                    outer: pts,
                    holes: Vec::new(),
                },
                ids,
            ));
        }
    }
    for i in 0..n {
        if depth(i) % 2 == 1
            && let Some((poly, ids)) = out.get_mut(slot[parent[i]])
        {
            let (mut pts, mut hid) = rings[i].clone();
            if poly2d::signed_area(&pts) > 0.0 {
                pts.reverse();
                hid.reverse();
            }
            poly.holes.push(pts);
            ids.extend(hid);
        }
    }
    out
}

pub fn point_inside_mesh(mesh: &TriMesh, p: V3) -> bool {
    let dir = [0.573_462_9, 0.577_350_2, 0.581_184_7];
    let mut hits = 0u32;
    for &t in &mesh.triangles {
        let [a, b, c] = mesh.corners(t);
        if ray_distance(p, dir, a, b, c).is_some() {
            hits += 1;
        }
    }
    hits % 2 == 1
}

fn ray_distance(o: V3, d: V3, a: V3, b: V3, c: V3) -> Option<f64> {
    let e1 = vec3::sub(b, a);
    let e2 = vec3::sub(c, a);
    let h = vec3::cross(d, e2);
    let det = vec3::dot(e1, h);
    if det.abs() < 1e-300 {
        return None;
    }
    let inv = 1.0 / det;
    let s = vec3::sub(o, a);
    let u = vec3::dot(s, h) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = vec3::cross(s, e1);
    let v = vec3::dot(d, q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = vec3::dot(e2, q) * inv;
    (t > 0.0).then_some(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    #[test]
    fn halfspace_cut_of_a_sphere_is_closed() {
        let s = build::uv_sphere([0.0; 3], 10.0, 32, 64);
        let b = s.bounds().unwrap();
        let low = intersect(&s, &Region::halfspace(Plane::horizontal(3.0), &b)).unwrap();
        assert!(low.edge_report().is_watertight(), "{:?}", low.edge_report());
        let high = intersect(&s, &Region::halfspace(Plane::horizontal(3.0).flipped(), &b)).unwrap();
        assert!(high.edge_report().is_watertight());
        assert!((low.volume() + high.volume() - s.volume()).abs() < 1e-6 * s.volume());
    }

    #[test]
    fn cut_through_a_torus_hole_gives_rings() {
        let t = build::torus([0.0; 3], 20.0, 6.0, 90, 48);
        let plane = Plane::new([0.0; 3], [1.0, 0.0, 0.0]).unwrap();
        let (a, c) = split_by_plane(&t, &plane).unwrap();
        assert!(a.edge_report().is_watertight());
        assert!(c.edge_report().is_watertight());
        assert_eq!(a.components().len(), 1);
        let (lo, hi) = split_by_plane(&t, &Plane::horizontal(0.5)).unwrap();
        assert!(lo.edge_report().is_watertight());
        assert!(hi.edge_report().is_watertight());
        assert!((lo.volume() + hi.volume() - t.volume()).abs() < 1e-6 * t.volume());
    }

    #[test]
    fn cut_exactly_on_a_face_is_clean() {
        let cube = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        let (lo, hi) = split_by_plane(&cube, &Plane::horizontal(10.0)).unwrap();
        assert!((lo.volume() - 1000.0).abs() < 1e-9);
        assert!(hi.is_empty());
        let (lo, hi) = split_by_plane(&cube, &Plane::horizontal(4.0)).unwrap();
        assert!((lo.volume() - 400.0).abs() < 1e-9 && (hi.volume() - 600.0).abs() < 1e-9);
        assert!(lo.edge_report().is_watertight() && hi.edge_report().is_watertight());
    }

    #[test]
    fn subtract_a_through_hole() {
        let slab = build::box_mesh([0.0; 3], [20.0, 20.0, 5.0]);
        let f = Frame::from_normal([10.0, 10.0, 0.0], [0.0, 0.0, 1.0], None).unwrap();
        let hole = ConvexSolid::cylinder(&f, 3.0, -1.0, 6.0, 24).unwrap();
        let m = subtract(&slab, &hole).unwrap();
        assert!(m.edge_report().is_watertight(), "{:?}", m.edge_report());
        let hex = poly2d::Polygon::simple(poly2d::circle([0.0, 0.0], 3.0, 24));
        assert!((m.volume() - (2000.0 - hex.area() * 5.0)).abs() < 1e-6);
        let e = m.triangles.len() * 3 / 2;
        assert_eq!(m.positions.len() + m.triangles.len(), e);
    }

    #[test]
    fn subtract_a_blind_socket_and_a_corner_notch() {
        let cube = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
        let f = Frame::from_normal([10.0, 10.0, 20.0], [0.0, 0.0, -1.0], None).unwrap();
        let socket = ConvexSolid::cylinder(&f, 2.5, -1.0, 8.0, 20).unwrap();
        let m = subtract(&cube, &socket).unwrap();
        assert!(m.edge_report().is_watertight(), "{:?}", m.edge_report());
        let notch = ConvexSolid {
            planes: vec![
                Plane::new([15.0, 0.0, 0.0], [-1.0, 0.0, 0.0]).unwrap(),
                Plane::new([0.0, 5.0, 0.0], [0.0, 1.0, 0.0]).unwrap(),
                Plane::new([0.0, 0.0, 12.0], [0.0, 0.0, -1.0]).unwrap(),
            ],
        };
        let m2 = subtract(&m, &notch).unwrap();
        assert!(m2.edge_report().is_watertight(), "{:?}", m2.edge_report());
        assert!((m.volume() - m2.volume() - 5.0 * 5.0 * 8.0).abs() < 1e-6);
    }

    #[test]
    fn pin_region_adds_material_above_the_cut() {
        let cube = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
        let b = cube.bounds().unwrap();
        let f = Frame::from_normal([10.0, 10.0, 10.0], [0.0, 0.0, 1.0], None).unwrap();
        let pin = ConvexSolid::cylinder(&f, 2.0, -1.0, 5.0, 16).unwrap();
        let region = Region::cut_with(Plane::horizontal(10.0), &b, std::slice::from_ref(&pin), &[]);
        let lower = intersect(&cube, &region).unwrap();
        assert!(lower.edge_report().is_watertight(), "{:?}", lower.edge_report());
        let area = poly2d::Polygon::simple(poly2d::circle([0.0, 0.0], 2.0, 16)).area();
        assert!(
            (lower.volume() - (4000.0 + area * 5.0)).abs() < 1e-6,
            "{} {}",
            lower.volume(),
            area
        );
        let socket = ConvexSolid::cylinder(&f, 2.2, -1.0, 5.3, 16).unwrap();
        let upper = intersect(
            &cube,
            &Region::cut_with(Plane::horizontal(10.0).flipped(), &b, &[], &[socket]),
        )
        .unwrap();
        assert!(upper.edge_report().is_watertight(), "{:?}", upper.edge_report());
    }
}
