// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! measure
// triangle and vertex indices come from the mesh, which is validated first
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::vec3::{self, Frame, V2, V3};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// edges whose faces meet at more than this many degrees are feature edges
pub const SHARP_DEG: f64 = 30.0;
/// triangles within this many degrees of the seed count as one flat face
const FLAT_DEG: f64 = 0.5;
const MAX_REGION: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Feature {
    Point {
        at: V3,
    },
    Edge {
        a: V3,
        b: V3,
    },
    Circle {
        center: V3,
        axis: V3,
        radius: f64,
        #[serde(default)]
        sweep_deg: f64,
    },
    Plane {
        point: V3,
        normal: V3,
        #[serde(default)]
        area_mm2: f64,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        triangles: Vec<u32>,
    },
    Cylinder {
        point: V3,
        axis: V3,
        radius: f64,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        triangles: Vec<u32>,
    },
    Surface {
        at: V3,
        normal: V3,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        triangles: Vec<u32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub triangle: u32,
    pub at: V3,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<V3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<V3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_mm: Option<V3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub center_distance_mm: Option<f64>,
    /// angle between directions: 0 to 180 for two faces, 0 to 90 otherwise
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parallel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diameter_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area_mm2: Option<f64>,
}

type Key = [u64; 3];

fn key(p: V3) -> Key {
    // +0.0 and -0.0 are the same point
    p.map(|c| (c + 0.0).to_bits())
}

pub struct Topology<'a> {
    pub mesh: &'a TriMesh,
    pub normals: Vec<V3>,
    edges: HashMap<(Key, Key), Vec<u32>>,
}

fn ekey(a: Key, b: Key) -> (Key, Key) {
    if a <= b { (a, b) } else { (b, a) }
}

impl<'a> Topology<'a> {
    pub fn new(mesh: &'a TriMesh) -> Self {
        let normals = mesh
            .triangles
            .iter()
            .map(|&t| vec3::normalize(mesh.normal(t)).unwrap_or([0.0; 3]))
            .collect();
        let mut edges: HashMap<(Key, Key), Vec<u32>> = HashMap::with_capacity(mesh.triangles.len() * 2);
        for (i, t) in mesh.triangles.iter().enumerate() {
            let k = t.map(|v| key(mesh.positions[v as usize]));
            for j in 0..3 {
                #[allow(clippy::cast_possible_truncation, reason = "triangle counts fit u32")]
                edges
                    .entry(ekey(k[j], k[(j + 1) % 3]))
                    .or_default()
                    .push(i as u32);
            }
        }
        Self { mesh, normals, edges }
    }

    pub fn corners(&self, t: u32) -> [V3; 3] {
        self.mesh.corners(self.mesh.triangles[t as usize])
    }

    pub fn edge_faces(&self, a: V3, b: V3) -> &[u32] {
        self.edges.get(&ekey(key(a), key(b))).map_or(&[], Vec::as_slice)
    }

    pub fn is_sharp(&self, a: V3, b: V3) -> bool {
        let f = self.edge_faces(a, b);
        if f.len() != 2 {
            return true;
        }
        let d = vec3::dot(self.normals[f[0] as usize], self.normals[f[1] as usize]);
        d < SHARP_DEG.to_radians().m_cos()
    }

    pub fn neighbors(&self, t: u32) -> impl Iterator<Item = (u32, V3, V3)> + '_ {
        let c = self.corners(t);
        (0..3).flat_map(move |j| {
            let (a, b) = (c[j], c[(j + 1) % 3]);
            self.edge_faces(a, b)
                .iter()
                .copied()
                .filter(move |&n| n != t)
                .map(move |n| (n, a, b))
        })
    }

    pub fn grow(&self, seed: u32, keep: impl Fn(u32, u32, V3, V3) -> bool) -> Vec<u32> {
        let mut seen = HashSet::from([seed]);
        let mut stack = vec![seed];
        let mut out = Vec::new();
        while let Some(t) = stack.pop() {
            out.push(t);
            if out.len() >= MAX_REGION {
                break;
            }
            for (n, a, b) in self.neighbors(t) {
                if !seen.contains(&n) && keep(t, n, a, b) {
                    seen.insert(n);
                    stack.push(n);
                }
            }
        }
        out
    }

    pub fn flat_region(&self, seed: u32) -> Vec<u32> {
        let n0 = self.normals[seed as usize];
        let p0 = self.corners(seed)[0];
        let cos = FLAT_DEG.to_radians().m_cos();
        let size = self.mesh.bounds().map_or(1.0, |b| b.diagonal());
        let tol = (size * 1e-6).max(1e-6).max(size * 1e-4);
        self.grow(seed, |_, n, _, _| {
            vec3::dot(self.normals[n as usize], n0) > cos
                && self
                    .corners(n)
                    .iter()
                    .all(|&p| vec3::dot(vec3::sub(p, p0), n0).abs() < tol)
        })
    }

    pub fn region_boundary(&self, region: &[u32]) -> Vec<(V3, V3)> {
        let set: HashSet<u32> = region.iter().copied().collect();
        let mut out = Vec::new();
        for &t in region {
            let c = self.corners(t);
            for j in 0..3 {
                let (a, b) = (c[j], c[(j + 1) % 3]);
                if !self.edge_faces(a, b).iter().any(|&n| n != t && set.contains(&n)) {
                    out.push((a, b));
                }
            }
        }
        out
    }

    pub fn area(&self, region: &[u32]) -> f64 {
        region
            .iter()
            .map(|&t| {
                let [a, b, c] = self.corners(t);
                vec3::len(vec3::tri_normal(a, b, c)) * 0.5
            })
            .sum()
    }

    fn centroid(&self, region: &[u32]) -> V3 {
        let mut acc = [0.0; 3];
        let mut total = 0.0;
        for &t in region {
            let [a, b, c] = self.corners(t);
            let w = vec3::len(vec3::tri_normal(a, b, c)) * 0.5;
            acc = vec3::add(acc, vec3::scale(vec3::add(vec3::add(a, b), c), w / 3.0));
            total += w;
        }
        if total > 0.0 {
            vec3::scale(acc, 1.0 / total)
        } else {
            region.first().map_or([0.0; 3], |&t| self.corners(t)[0])
        }
    }
}

/// eigenvector of the smallest eigenvalue of a symmetric 3 x 3 matrix (cyclic Jacobi)
fn smallest_eigenvector(m: [[f64; 3]; 3]) -> V3 {
    let mut a = m;
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..32 {
        let off = a[0][1].abs() + a[0][2].abs() + a[1][2].abs();
        if off < 1e-15 {
            break;
        }
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            if a[p][q].abs() < 1e-300 {
                continue;
            }
            let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
            let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
            let t = if theta == 0.0 { 1.0 } else { t };
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            for row in &mut a {
                let (akp, akq) = (row[p], row[q]);
                row[p] = c * akp - s * akq;
                row[q] = s * akp + c * akq;
            }
            let (lo, hi) = a.split_at_mut(q);
            for (apk, aqk) in lo[p].iter_mut().zip(hi[0].iter_mut()) {
                let (x, y) = (*apk, *aqk);
                *apk = c * x - s * y;
                *aqk = s * x + c * y;
            }
            for row in &mut v {
                let (vp, vq) = (row[p], row[q]);
                row[p] = c * vp - s * vq;
                row[q] = s * vp + c * vq;
            }
        }
    }
    let i = (0..3).min_by(|&x, &y| a[x][x].total_cmp(&a[y][y])).unwrap_or(2);
    vec3::normalize([v[0][i], v[1][i], v[2][i]]).unwrap_or([0.0, 0.0, 1.0])
}

/// least squares circle through 2D points (Kasa)
fn fit_circle_2d(pts: &[V2]) -> Option<(V2, f64, f64)> {
    if pts.len() < 3 {
        return None;
    }
    let n = pts.len() as f64;
    let (mx, my) = pts
        .iter()
        .fold((0.0, 0.0), |(x, y), p| (x + p[0] / n, y + p[1] / n));
    let (mut suu, mut svv, mut suv, mut suuu, mut svvv, mut suvv, mut svuu) =
        (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for p in pts {
        let (u, v) = (p[0] - mx, p[1] - my);
        suu += u * u;
        svv += v * v;
        suv += u * v;
        suuu += u * u * u;
        svvv += v * v * v;
        suvv += u * v * v;
        svuu += v * u * u;
    }
    let det = suu * svv - suv * suv;
    if det.abs() < 1e-18 {
        return None;
    }
    let b1 = f64::midpoint(suuu, suvv);
    let b2 = f64::midpoint(svvv, svuu);
    let uc = (b1 * svv - b2 * suv) / det;
    let vc = (b2 * suu - b1 * suv) / det;
    let c = [uc + mx, vc + my];
    let r = pts
        .iter()
        .map(|p| ((p[0] - c[0]).m_powi(2) + (p[1] - c[1]).m_powi(2)).sqrt())
        .sum::<f64>()
        / n;
    let err = pts
        .iter()
        .map(|p| (((p[0] - c[0]).m_powi(2) + (p[1] - c[1]).m_powi(2)).sqrt() - r).abs())
        .fold(0.0, f64::max);
    Some((c, r, err))
}

/// The cylinder the triangles `region` of `mesh` lie on, as a point on its axis, the unit axis and the radius,
/// when every normal is nearly square to one axis and the corners fit a circle around it to within `rel` of the
/// radius.
pub(crate) fn fit_cylinder(mesh: &TriMesh, region: &[u32], rel: f64) -> Option<(V3, V3, f64)> {
    let mut cov = [[0.0; 3]; 3];
    let mut normals = Vec::with_capacity(region.len());
    for &r in region {
        let [a, b, c] = mesh.corners(*mesh.triangles.get(r as usize)?);
        let n = vec3::tri_normal(a, b, c);
        let w = vec3::len(n);
        let n = vec3::normalize(n)?;
        for i in 0..3 {
            for j in 0..3 {
                cov[i][j] += w * n[i] * n[j];
            }
        }
        normals.push(n);
    }
    let axis = smallest_eigenvector(cov);
    if !normals.iter().all(|&n| vec3::dot(n, axis).abs() < 0.12) {
        return None;
    }
    let frame = Frame::from_normal([0.0; 3], axis, None)?;
    let mut pts = Vec::new();
    let mut seen = HashSet::new();
    for &r in region {
        for p in mesh.corners(mesh.triangles[r as usize]) {
            if seen.insert(key(p)) {
                pts.push(frame.project(p));
            }
        }
    }
    let (c, r, err) = fit_circle_2d(&pts)?;
    (err < rel * r).then(|| (frame.at(c, 0.0), axis, r))
}

fn fit_circle_3d(pts: &[V3], closed: bool) -> Option<Feature> {
    if pts.len() < 5 {
        return None;
    }
    let n = pts.len() as f64;
    let c0 = vec3::scale(pts.iter().fold([0.0; 3], |a, &p| vec3::add(a, p)), 1.0 / n);
    let mut cov = [[0.0; 3]; 3];
    for p in pts {
        let d = vec3::sub(*p, c0);
        for i in 0..3 {
            for j in 0..3 {
                cov[i][j] += d[i] * d[j];
            }
        }
    }
    let axis = smallest_eigenvector(cov);
    let frame = Frame::from_normal(c0, axis, None)?;
    let flat = pts.iter().map(|&p| frame.height(p).abs()).fold(0.0, f64::max);
    let local: Vec<V2> = pts.iter().map(|&p| frame.project(p)).collect();
    let (c, r, err) = fit_circle_2d(&local)?;
    if !(r.is_finite() && r > 0.0) || err > 0.02 * r || flat > 0.02 * r {
        return None;
    }
    let mut sweep = 0.0;
    for w in local.windows(2) {
        let a = (w[0][1] - c[1]).m_atan2(w[0][0] - c[0]);
        let b = (w[1][1] - c[1]).m_atan2(w[1][0] - c[0]);
        let mut d = b - a;
        while d > std::f64::consts::PI {
            d -= std::f64::consts::TAU;
        }
        while d < -std::f64::consts::PI {
            d += std::f64::consts::TAU;
        }
        sweep += d;
    }
    let sweep_deg = if closed {
        360.0
    } else {
        sweep.abs().to_degrees().min(360.0)
    };
    if sweep_deg < 45.0 {
        return None;
    }
    Some(Feature::Circle {
        center: frame.at(c, 0.0),
        axis,
        radius: r,
        sweep_deg,
    })
}

fn seg_closest(p: V3, a: V3, b: V3) -> (V3, f64) {
    let ab = vec3::sub(b, a);
    let l2 = vec3::dot(ab, ab);
    let t = if l2 > 0.0 {
        (vec3::dot(vec3::sub(p, a), ab) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let q = vec3::add(a, vec3::scale(ab, t));
    (q, vec3::len(vec3::sub(p, q)))
}

impl Topology<'_> {
    fn sharp_from(&self, p: V3, around: &HashSet<u32>) -> Vec<V3> {
        let mut out = Vec::new();
        for &t in around {
            let c = self.corners(t);
            for j in 0..3 {
                let (a, b) = (c[j], c[(j + 1) % 3]);
                let other = if key(a) == key(p) {
                    b
                } else if key(b) == key(p) {
                    a
                } else {
                    continue;
                };
                if self.is_sharp(p, other) && !out.iter().any(|&o| key(o) == key(other)) {
                    out.push(other);
                }
            }
        }
        out
    }

    fn fan(&self, t: u32, p: V3) -> HashSet<u32> {
        let kp = key(p);
        let has = |t: u32| self.corners(t).iter().any(|&q| key(q) == kp);
        let mut seen = HashSet::from([t]);
        let mut stack = vec![t];
        while let Some(x) = stack.pop() {
            for (n, a, b) in self.neighbors(x) {
                if (key(a) == kp || key(b) == kp) && has(n) && seen.insert(n) {
                    stack.push(n);
                }
            }
        }
        seen
    }

    fn walk(&self, from: V3, to: V3, seed: u32, limit: usize) -> (Vec<V3>, bool) {
        let mut chain = vec![from, to];
        let start = key(from);
        let mut t = seed;
        while chain.len() < limit {
            let n = chain.len();
            let (prev, cur) = (chain[n - 2], chain[n - 1]);
            let fan = self.fan(t, cur);
            let next: Vec<V3> = self
                .sharp_from(cur, &fan)
                .into_iter()
                .filter(|&q| key(q) != key(prev))
                .collect();
            if next.len() != 1 {
                break;
            }
            let q = next[0];
            let d0 = vec3::normalize(vec3::sub(cur, prev)).unwrap_or([0.0; 3]);
            let d1 = vec3::normalize(vec3::sub(q, cur)).unwrap_or([0.0; 3]);
            if vec3::dot(d0, d1) < 45f64.to_radians().m_cos() {
                break;
            }
            if key(q) == start {
                return (chain, true);
            }
            if chain.iter().any(|&c| key(c) == key(q)) {
                break;
            }
            if let Some(&nt) = self.edge_faces(cur, q).first() {
                t = nt;
            }
            chain.push(q);
        }
        (chain, false)
    }

    fn edge_feature(&self, t: u32, a: V3, b: V3) -> Feature {
        let (fwd, closed) = self.walk(a, b, t, 4096);
        let chain = if closed {
            fwd
        } else {
            let (back, _) = self.walk(b, a, t, 4096);
            let mut c: Vec<V3> = back.iter().skip(1).rev().copied().collect();
            c.extend(fwd.iter().skip(1));
            c
        };
        if chain.len() >= 6
            && let Some(f) = fit_circle_3d(&chain, closed)
        {
            return f;
        }
        let dir = vec3::normalize(vec3::sub(b, a)).unwrap_or([1.0, 0.0, 0.0]);
        let on_line = |p: V3| {
            let d = vec3::sub(p, a);
            vec3::len(vec3::sub(d, vec3::scale(dir, vec3::dot(d, dir)))) < 1e-6 * (1.0 + vec3::len(d))
        };
        let along = |p: V3| vec3::dot(vec3::sub(p, a), dir);
        let ia = chain.iter().position(|&p| key(p) == key(a)).unwrap_or(0);
        let mut lo = ia;
        while lo > 0 && on_line(chain[lo - 1]) {
            lo -= 1;
        }
        let mut hi = ia;
        while hi + 1 < chain.len() && on_line(chain[hi + 1]) {
            hi += 1;
        }
        let (mut p, mut q) = (a, b);
        for &c in &chain[lo..=hi] {
            if along(c) < along(p) {
                p = c;
            }
            if along(c) > along(q) {
                q = c;
            }
        }
        Feature::Edge { a: p, b: q }
    }

    fn face_feature(&self, t: u32, at: V3) -> Feature {
        let flat = self.flat_region(t);
        let boundary = self.region_boundary(&flat);
        let smooth = boundary.iter().filter(|(a, b)| !self.is_sharp(*a, *b)).count();
        let plane = || Feature::Plane {
            point: self.centroid(&flat),
            normal: self.normals[t as usize],
            area_mm2: self.area(&flat),
            triangles: flat.clone(),
        };
        if smooth == 0 {
            return plane();
        }
        let region = self.grow(t, |_, _, a, b| !self.is_sharp(a, b));
        if let Some((origin, axis, radius)) = fit_cylinder(self.mesh, &region, 0.02) {
            return Feature::Cylinder {
                point: vec3::add(origin, vec3::scale(axis, vec3::dot(vec3::sub(at, origin), axis))),
                axis,
                radius,
                triangles: region,
            };
        }
        if flat.len() > 2 {
            return plane();
        }
        Feature::Surface {
            at,
            normal: self.normals[t as usize],
            triangles: region,
        }
    }

    pub fn resolve(&self, pick: Pick, snap_mm: f64) -> Result<Feature> {
        let t = pick.triangle;
        if t as usize >= self.mesh.triangles.len() {
            return Err(Error::invalid("triangle", "out of range"));
        }
        let c = self.corners(t);
        let snap = if snap_mm.is_finite() && snap_mm >= 0.0 {
            snap_mm
        } else {
            0.5
        };
        let corner = c
            .iter()
            .copied()
            .map(|p| (p, vec3::len(vec3::sub(p, pick.at))))
            .filter(|&(p, d)| d <= snap && !self.sharp_from(p, &self.fan(t, p)).is_empty())
            .min_by(|x, y| x.1.total_cmp(&y.1));
        if let Some((p, _)) = corner {
            let fan = self.fan(t, p);
            let sharp = self.sharp_from(p, &fan);
            let chain_vertex = sharp.len() == 2 && {
                let d0 = vec3::normalize(vec3::sub(p, sharp[0])).unwrap_or([0.0; 3]);
                let d1 = vec3::normalize(vec3::sub(sharp[1], p)).unwrap_or([0.0; 3]);
                vec3::dot(d0, d1) > 45f64.to_radians().m_cos()
            };
            if !chain_vertex {
                return Ok(Feature::Point { at: p });
            }
        }
        let edge = (0..3)
            .map(|j| (c[j], c[(j + 1) % 3]))
            .filter(|&(a, b)| self.is_sharp(a, b))
            .map(|(a, b)| (a, b, seg_closest(pick.at, a, b).1))
            .filter(|&(_, _, d)| d <= snap)
            .min_by(|x, y| x.2.total_cmp(&y.2));
        if let Some((a, b, _)) = edge {
            return Ok(self.edge_feature(t, a, b));
        }
        Ok(self.face_feature(t, pick.at))
    }
}

pub fn resolve(mesh: &TriMesh, pick: Pick, snap_mm: f64) -> Result<Feature> {
    mesh.validate("measure")?;
    Topology::new(mesh).resolve(pick, snap_mm)
}

enum Prim {
    Point(V3),
    Segment(V3, V3),
    Plane(V3, V3),
    Line(V3, V3),
}

fn prim(f: &Feature) -> Prim {
    match *f {
        Feature::Point { at } | Feature::Surface { at, .. } => Prim::Point(at),
        Feature::Edge { a, b } => Prim::Segment(a, b),
        Feature::Circle { center, .. } => Prim::Point(center),
        Feature::Plane { point, normal, .. } => Prim::Plane(point, normal),
        Feature::Cylinder { point, axis, .. } => Prim::Line(point, axis),
    }
}

fn center(f: &Feature) -> V3 {
    match *f {
        Feature::Point { at } | Feature::Surface { at, .. } => at,
        Feature::Edge { a, b } => vec3::lerp(a, b, 0.5),
        Feature::Circle { center, .. } => center,
        Feature::Plane { point, .. } | Feature::Cylinder { point, .. } => point,
    }
}

fn direction(f: &Feature) -> Option<(V3, bool)> {
    match *f {
        Feature::Edge { a, b } => vec3::normalize(vec3::sub(b, a)).map(|d| (d, false)),
        Feature::Circle { axis, .. } | Feature::Cylinder { axis, .. } => Some((axis, false)),
        Feature::Plane { normal, .. } => Some((normal, true)),
        Feature::Point { .. } | Feature::Surface { .. } => None,
    }
}

fn line_closest(p: V3, o: V3, d: V3) -> V3 {
    vec3::add(o, vec3::scale(d, vec3::dot(vec3::sub(p, o), d)))
}

fn plane_foot(p: V3, o: V3, n: V3) -> V3 {
    vec3::sub(p, vec3::scale(n, vec3::dot(vec3::sub(p, o), n)))
}

fn seg_seg(p1: V3, q1: V3, p2: V3, q2: V3) -> (V3, V3) {
    let d1 = vec3::sub(q1, p1);
    let d2 = vec3::sub(q2, p2);
    let r = vec3::sub(p1, p2);
    let (a, e, f) = (vec3::dot(d1, d1), vec3::dot(d2, d2), vec3::dot(d2, r));
    let (s, t) = if a <= 1e-18 && e <= 1e-18 {
        (0.0, 0.0)
    } else if a <= 1e-18 {
        (0.0, (f / e).clamp(0.0, 1.0))
    } else {
        let c = vec3::dot(d1, r);
        if e <= 1e-18 {
            ((-c / a).clamp(0.0, 1.0), 0.0)
        } else {
            let b = vec3::dot(d1, d2);
            let denom = a * e - b * b;
            let mut s = if denom > 1e-18 {
                ((b * f - c * e) / denom).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let mut t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            }
            (s, t)
        }
    };
    (
        vec3::add(p1, vec3::scale(d1, s)),
        vec3::add(p2, vec3::scale(d2, t)),
    )
}

/// closest points between two primitives; `None` for faces or axes that are not parallel (they meet, so only the angle is meaningful)
fn closest(a: &Prim, b: &Prim) -> Option<(V3, V3)> {
    use Prim::{Line, Plane, Point, Segment};
    Some(match (a, b) {
        (Point(p), Point(q)) => (*p, *q),
        (Point(p), Segment(s, e)) => (*p, seg_closest(*p, *s, *e).0),
        (Segment(..) | Plane(..) | Line(..), Point(_)) | (Plane(..), Segment(..)) => {
            let (x, y) = closest(b, a)?;
            (y, x)
        }
        (Point(p), Plane(o, n)) => (*p, plane_foot(*p, *o, *n)),
        (Point(p), Line(o, d)) => (*p, line_closest(*p, *o, *d)),
        (Segment(p1, q1), Segment(p2, q2)) => seg_seg(*p1, *q1, *p2, *q2),
        (Segment(s, e), Plane(o, n)) => {
            let (ds, de) = (vec3::dot(vec3::sub(*s, *o), *n), vec3::dot(vec3::sub(*e, *o), *n));
            if ds * de <= 0.0 && (ds - de).abs() > 1e-12 {
                let t = ds / (ds - de);
                let x = vec3::lerp(*s, *e, t);
                (x, x)
            } else if ds.abs() <= de.abs() {
                (*s, plane_foot(*s, *o, *n))
            } else {
                (*e, plane_foot(*e, *o, *n))
            }
        }
        (Plane(o1, n1), Plane(o2, n2)) => {
            if vec3::len(vec3::cross(*n1, *n2)) < 1e-3 {
                (*o1, plane_foot(*o1, *o2, *n2))
            } else {
                return None;
            }
        }
        (Line(o, d), Plane(p, n)) | (Plane(p, n), Line(o, d)) => {
            if vec3::dot(*d, *n).abs() < 1e-3 {
                let x = *o;
                let y = plane_foot(*o, *p, *n);
                if matches!(a, Line(..)) { (x, y) } else { (y, x) }
            } else {
                return None;
            }
        }
        (Line(o1, d1), Line(o2, d2)) => {
            let n = vec3::cross(*d1, *d2);
            if vec3::len(n) < 1e-6 {
                (*o1, line_closest(*o1, *o2, *d2))
            } else {
                let r = vec3::sub(*o1, *o2);
                let (b, c, f) = (vec3::dot(*d1, *d2), vec3::dot(*d1, r), vec3::dot(*d2, r));
                let denom = 1.0 - b * b;
                let s = (b * f - c) / denom;
                let t = (f - b * c) / denom;
                (
                    vec3::add(*o1, vec3::scale(*d1, s)),
                    vec3::add(*o2, vec3::scale(*d2, t)),
                )
            }
        }
        (Segment(s, e), Line(o, d)) | (Line(o, d), Segment(s, e)) => {
            let span = vec3::len(vec3::sub(*e, *s)) + vec3::len(vec3::sub(*s, *o)) + 1.0;
            let lp = vec3::sub(*o, vec3::scale(*d, span * 4.0));
            let lq = vec3::add(*o, vec3::scale(*d, span * 4.0));
            let (x, y) = seg_seg(*s, *e, lp, lq);
            if matches!(a, Segment(..)) { (x, y) } else { (y, x) }
        }
    })
}

pub fn measure(a: &Feature, b: Option<&Feature>) -> Measurement {
    let mut m = Measurement::default();
    let Some(b) = b else {
        match *a {
            Feature::Edge { a: p, b: q } => m.length_mm = Some(vec3::len(vec3::sub(q, p))),
            Feature::Circle { radius, .. } | Feature::Cylinder { radius, .. } => {
                m.radius_mm = Some(radius);
                m.diameter_mm = Some(radius * 2.0);
            }
            Feature::Plane { area_mm2, .. } => m.area_mm2 = Some(area_mm2),
            Feature::Point { .. } | Feature::Surface { .. } => {}
        }
        return m;
    };
    if let Some((p, q)) = closest(&prim(a), &prim(b)) {
        m.distance_mm = Some(vec3::len(vec3::sub(q, p)));
        m.from = Some(p);
        m.to = Some(q);
        m.delta_mm = Some(vec3::sub(q, p));
    }
    let (ca, cb) = (center(a), center(b));
    let has_center = |f: &Feature| {
        matches!(
            f,
            Feature::Circle { .. } | Feature::Cylinder { .. } | Feature::Plane { .. }
        )
    };
    if has_center(a) || has_center(b) {
        m.center_distance_mm = Some(vec3::len(vec3::sub(cb, ca)));
    }
    if let (Some((da, fa)), Some((db, fb))) = (direction(a), direction(b)) {
        let c = vec3::dot(da, db).clamp(-1.0, 1.0);
        let faces = fa && fb;
        let ang = if faces {
            c.m_acos().to_degrees()
        } else {
            let a = c.abs().m_acos().to_degrees();
            if fa == fb { a } else { 90.0 - a }
        };
        m.angle_deg = Some(ang);
        let par = if faces || !(fa || fb) {
            vec3::len(vec3::cross(da, db)) < 1e-3
        } else {
            vec3::dot(da, db).abs() < 1e-3
        };
        m.parallel = Some(par);
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boolean::{self, BoolOp, BooleanOptions};
    use crate::build;

    fn tri_at(m: &TriMesh, p: V3, n: V3) -> u32 {
        for (i, &t) in m.triangles.iter().enumerate() {
            let [a, b, c] = m.corners(t);
            let nn = vec3::normalize(m.normal(t)).unwrap();
            if vec3::dot(nn, n) < 0.99 {
                continue;
            }
            let area = |x: V3, y: V3, z: V3| vec3::dot(vec3::tri_normal(x, y, z), nn);
            if area(a, b, p) >= -1e-9 && area(b, c, p) >= -1e-9 && area(c, a, p) >= -1e-9 {
                return u32::try_from(i).unwrap();
            }
        }
        panic!("no triangle at {p:?}");
    }

    fn plate_with_hole() -> TriMesh {
        let plate = build::box_mesh([0.0; 3], [40.0, 20.0, 5.0]);
        let frame = vec3::Frame::from_normal([10.0, 10.0, 0.0], [0.0, 0.0, 1.0], None).unwrap();
        let hole = build::cylinder(&frame, 3.0, -1.0, 6.0, 64);
        boolean::boolean(&[plate], &[hole], BoolOp::Difference, &BooleanOptions::default())
            .unwrap()
            .0
    }

    #[test]
    fn faces_edges_and_corners() {
        let m = build::box_mesh([0.0; 3], [40.0, 20.0, 5.0]);
        let top = tri_at(&m, [30.0, 15.0, 5.0], [0.0, 0.0, 1.0]);
        let f = resolve(
            &m,
            Pick {
                triangle: top,
                at: [30.0, 15.0, 5.0],
            },
            0.5,
        )
        .unwrap();
        let Feature::Plane { normal, area_mm2, .. } = f else {
            panic!("{f:?}")
        };
        assert!((normal[2] - 1.0).abs() < 1e-9 && (area_mm2 - 800.0).abs() < 1e-6);
        let near = tri_at(&m, [30.0, 19.8, 5.0], [0.0, 0.0, 1.0]);
        let edge = resolve(
            &m,
            Pick {
                triangle: near,
                at: [30.0, 19.8, 5.0],
            },
            0.5,
        )
        .unwrap();
        assert_eq!(measure(&edge, None).length_mm, Some(40.0));
        let corner = resolve(
            &m,
            Pick {
                triangle: near,
                at: [39.8, 19.8, 5.0],
            },
            0.5,
        )
        .unwrap();
        assert_eq!(
            corner,
            Feature::Point {
                at: [40.0, 20.0, 5.0]
            }
        );
        let bottom = tri_at(&m, [10.0, 5.0, 0.0], [0.0, 0.0, -1.0]);
        let g = resolve(
            &m,
            Pick {
                triangle: bottom,
                at: [10.0, 5.0, 0.0],
            },
            0.5,
        )
        .unwrap();
        let r = measure(&f, Some(&g));
        assert_eq!(r.parallel, Some(true));
        assert!((r.distance_mm.unwrap() - 5.0).abs() < 1e-9);
        assert!((r.angle_deg.unwrap() - 180.0).abs() < 1e-6);
        let side = tri_at(&m, [40.0, 10.0, 2.0], [1.0, 0.0, 0.0]);
        let s = resolve(
            &m,
            Pick {
                triangle: side,
                at: [40.0, 10.0, 2.0],
            },
            0.5,
        )
        .unwrap();
        assert!((measure(&f, Some(&s)).angle_deg.unwrap() - 90.0).abs() < 1e-6);
    }

    #[test]
    fn hole_rim_and_wall() {
        let m = plate_with_hole();
        let at = [10.0 + 3.1, 10.0, 5.0];
        let top = tri_at(&m, at, [0.0, 0.0, 1.0]);
        let f = resolve(&m, Pick { triangle: top, at }, 0.3).unwrap();
        let Feature::Circle { radius, center, .. } = f else {
            panic!("{f:?}")
        };
        assert!((radius - 3.0).abs() < 0.01, "{radius}");
        assert!(vec3::len(vec3::sub(center, [10.0, 10.0, 5.0])) < 0.01);
        let wall = m
            .triangles
            .iter()
            .position(|&t| {
                let c = m.corners(t);
                c.iter().all(|p| (p[0] - 10.0).m_hypot(p[1] - 10.0) < 3.01) && c.iter().any(|p| p[2] > 2.0)
            })
            .map(|i| u32::try_from(i).unwrap())
            .unwrap();
        let at = m
            .corners(m.triangles[wall as usize])
            .iter()
            .fold([0.0; 3], |a, &p| vec3::add(a, vec3::scale(p, 1.0 / 3.0)));
        let c = resolve(&m, Pick { triangle: wall, at }, 0.0).unwrap();
        let Feature::Cylinder { radius, axis, .. } = c else {
            panic!("{c:?}")
        };
        assert!((radius - 3.0).abs() < 0.01 && axis[2].abs() > 0.999);
        let r = measure(&c, None);
        assert!((r.diameter_mm.unwrap() - 6.0).abs() < 0.02);
        let end = tri_at(&m, [40.0, 10.0, 2.0], [1.0, 0.0, 0.0]);
        let e = resolve(
            &m,
            Pick {
                triangle: end,
                at: [40.0, 10.0, 2.0],
            },
            0.0,
        )
        .unwrap();
        let d = measure(&c, Some(&e));
        assert!((d.distance_mm.unwrap() - 30.0).abs() < 0.01, "{d:?}");
    }

    #[test]
    fn eigen_and_circle_fit() {
        let v = smallest_eigenvector([[4.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 9.0]]);
        assert!((v[1].abs() - 1.0).abs() < 1e-12);
        let pts: Vec<[f64; 2]> = (0..20)
            .map(|i| {
                let a = f64::from(i) * 0.2;
                [3.0 + 5.0 * a.m_cos(), -1.0 + 5.0 * a.m_sin()]
            })
            .collect();
        let (c, r, e) = fit_circle_2d(&pts).unwrap();
        assert!((c[0] - 3.0).abs() < 1e-9 && (c[1] + 1.0).abs() < 1e-9 && (r - 5.0).abs() < 1e-9 && e < 1e-9);
    }
}
