// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the indexed triangle mesh, welding, edge checks and STL input and output
// indices into `positions` are checked by `TriMesh::validate` when a mesh
// enters the crate; everything here keeps them in range
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::faces::Faces;
use crate::vec3::{self, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Aabb {
    pub min: V3,
    pub max: V3,
}

impl Aabb {
    pub fn size(&self) -> V3 {
        vec3::sub(self.max, self.min)
    }

    pub fn center(&self) -> V3 {
        vec3::scale(vec3::add(self.min, self.max), 0.5)
    }

    pub fn diagonal(&self) -> f64 {
        vec3::len(self.size())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TriMesh {
    pub positions: Vec<V3>,
    pub triangles: Vec<[u32; 3]>,
    /// The face each triangle belongs to and what surface it is, when known (`faces.rs`). Ops that make geometry
    /// tag it; ops that only move or drop triangles carry it along; the rest leave it out.
    #[cfg_attr(feature = "cad", serde(default, skip_serializing_if = "Option::is_none"))]
    #[cfg_attr(not(feature = "cad"), serde(skip))]
    pub faces: Option<Faces>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeReport {
    pub boundary_edges: usize,
    pub non_manifold_edges: usize,
    pub flipped_edges: usize,
}

impl EdgeReport {
    pub fn is_watertight(&self) -> bool {
        self.boundary_edges == 0 && self.non_manifold_edges == 0 && self.flipped_edges == 0
    }
}

pub fn weld_tolerance(bounds: Option<Aabb>) -> f64 {
    bounds.map_or(1e-6, |b| (b.diagonal() * 1e-9).max(1e-7))
}

impl TriMesh {
    pub fn new(positions: Vec<V3>, triangles: Vec<[u32; 3]>) -> Self {
        Self {
            positions,
            triangles,
            faces: None,
        }
    }

    pub fn from_f32(positions: &[[f32; 3]], triangles: &[[u32; 3]]) -> Result<Self> {
        let m = Self {
            positions: positions.iter().map(|p| p.map(f64::from)).collect(),
            triangles: triangles.to_vec(),
            faces: None,
        };
        m.validate("mesh")?;
        Ok(m)
    }

    pub fn from_flat(positions: &[f64], indices: &[u32]) -> Result<Self> {
        if !positions.len().is_multiple_of(3) || !indices.len().is_multiple_of(3) {
            return Err(Error::mesh(
                "mesh",
                "positions and indices must be multiples of 3",
            ));
        }
        let m = Self {
            positions: positions.as_chunks::<3>().0.to_vec(),
            triangles: indices.as_chunks::<3>().0.to_vec(),
            faces: None,
        };
        m.validate("mesh")?;
        Ok(m)
    }

    /// A mesh in the raw form the app's geometry worker writes, so a big mesh crosses into the engine without JSON: the
    /// vertex count and the triangle count as little-endian u32, then the positions as f32 x, y, z and the triangles as
    /// u32 corners, little endian.
    pub fn from_raw(bytes: &[u8], name: &str) -> Result<Self> {
        let word = |at: usize| -> Option<[u8; 4]> { bytes.get(at..at + 4).and_then(|b| b.try_into().ok()) };
        let head = |at: usize| {
            word(at)
                .map(|b| u32::from_le_bytes(b) as usize)
                .ok_or_else(|| Error::mesh(name, "raw mesh shorter than its header"))
        };
        let (nv, nt) = (head(0)?, head(4)?);
        let tris_at = nv.checked_mul(12).and_then(|b| b.checked_add(8));
        let end = tris_at.and_then(|t| nt.checked_mul(12).and_then(|b| t.checked_add(b)));
        let (Some(tris_at), Some(end)) = (tris_at, end) else {
            return Err(Error::mesh(name, "raw mesh too large"));
        };
        if end != bytes.len() {
            return Err(Error::mesh(name, "raw mesh size does not match its header"));
        }
        let f = |at: usize| word(at).map_or(0.0, |b| f64::from(f32::from_le_bytes(b)));
        let u = |at: usize| word(at).map_or(0, u32::from_le_bytes);
        let m = Self {
            positions: (0..nv)
                .map(|i| [f(8 + 12 * i), f(12 + 12 * i), f(16 + 12 * i)])
                .collect(),
            triangles: (0..nt)
                .map(|i| {
                    [
                        u(tris_at + 12 * i),
                        u(tris_at + 4 + 12 * i),
                        u(tris_at + 8 + 12 * i),
                    ]
                })
                .collect(),
            faces: None,
        };
        m.validate(name)?;
        Ok(m)
    }

    #[allow(clippy::cast_possible_truncation, reason = "print geometry fits in f32")]
    pub fn to_f32(&self) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
        (
            self.positions.iter().map(|p| p.map(|c| c as f32)).collect(),
            self.triangles.clone(),
        )
    }

    pub fn validate(&self, name: &str) -> Result<()> {
        if u32::try_from(self.positions.len()).is_err() {
            return Err(Error::mesh(name, "more than 2^32 vertices"));
        }
        if let Some(p) = self
            .positions
            .iter()
            .position(|p| p.iter().any(|c| !c.is_finite()))
        {
            return Err(Error::mesh(name, format!("vertex {p} is not finite")));
        }
        let n = self.positions.len();
        if let Some(t) = self
            .triangles
            .iter()
            .position(|t| t.iter().any(|&i| i as usize >= n))
        {
            return Err(Error::mesh(
                name,
                format!("triangle {t} points past the vertex list"),
            ));
        }
        if let Some(f) = &self.faces {
            f.check(name, self.triangles.len())?;
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.triangles.is_empty()
    }

    pub fn corners(&self, t: [u32; 3]) -> [V3; 3] {
        t.map(|i| self.positions[i as usize])
    }

    pub fn normal(&self, t: [u32; 3]) -> V3 {
        let [a, b, c] = self.corners(t);
        vec3::normalize(vec3::tri_normal(a, b, c)).unwrap_or([0.0; 3])
    }

    pub fn bounds(&self) -> Option<Aabb> {
        let mut it = self
            .triangles
            .iter()
            .flatten()
            .map(|&i| self.positions[i as usize]);
        let first = it.next()?;
        let (mut min, mut max) = (first, first);
        for p in it {
            for k in 0..3 {
                min[k] = min[k].min(p[k]);
                max[k] = max[k].max(p[k]);
            }
        }
        Some(Aabb { min, max })
    }

    /// surface area in mm^2
    pub fn area(&self) -> f64 {
        self.triangles
            .iter()
            .map(|&t| {
                let [a, b, c] = self.corners(t);
                vec3::len(vec3::tri_normal(a, b, c)) * 0.5
            })
            .sum()
    }

    /// enclosed volume in mm^3 (positive for outward-facing closed meshes)
    pub fn volume(&self) -> f64 {
        let o = self.bounds().map_or([0.0; 3], |b| b.center());
        self.triangles
            .iter()
            .map(|&t| {
                let [a, b, c] = self.corners(t).map(|p| vec3::sub(p, o));
                vec3::dot(a, vec3::cross(b, c)) / 6.0
            })
            .sum()
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "vertex counts are checked below 2^32"
    )]
    pub fn append(&mut self, other: &TriMesh) {
        let base = self.positions.len() as u32;
        // Faces stay when both sides have them (or this side is empty); otherwise the result has none.
        self.faces = match (self.triangles.is_empty(), self.faces.take(), &other.faces) {
            (true, _, f) => f.clone(),
            (false, Some(mut a), Some(b)) => {
                let shift = a.table.len() as u32;
                a.ids.extend(b.ids.iter().map(|&id| id + shift));
                a.table.extend_from_slice(&b.table);
                Some(a)
            }
            _ => None,
        };
        self.positions.extend_from_slice(&other.positions);
        self.triangles
            .extend(other.triangles.iter().map(|t| t.map(|i| i + base)));
    }

    #[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
    pub fn push_vertex(&mut self, p: V3) -> u32 {
        self.positions.push(p);
        (self.positions.len() - 1) as u32
    }

    /// Adds a triangle with no face, so the mesh's faces are dropped.
    pub fn push_triangle(&mut self, a: V3, b: V3, c: V3) {
        self.faces = None;
        let i = self.push_vertex(a);
        let j = self.push_vertex(b);
        let k = self.push_vertex(c);
        self.triangles.push([i, j, k]);
    }

    /// Moves every vertex. The surfaces of the faces cannot follow an arbitrary map, so they are dropped; a
    /// rigid transform keeps them through `xform`.
    pub fn map_positions(&mut self, f: impl Fn(V3) -> V3) {
        self.faces = None;
        for p in &mut self.positions {
            *p = f(*p);
        }
    }

    pub fn translate(&mut self, d: V3) {
        let faces = self.faces.take();
        self.map_positions(|p| vec3::add(p, d));
        self.faces = faces.map(|f| f.transformed(&crate::xform::translation(d)));
    }

    pub fn flip(&mut self) {
        for t in &mut self.triangles {
            t.swap(1, 2);
        }
    }

    #[must_use]
    pub fn weld(&self, tol: f64) -> TriMesh {
        let tol = tol.max(0.0);
        if tol == 0.0 {
            return self.weld_exact();
        }
        self.weld_grid(tol)
    }

    /// The weld within `tol` through a grid of cells twice its size, searching the 27 cells around each corner.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "grid cells of print-sized models fit in i64"
    )]
    fn weld_grid(&self, tol: f64) -> TriMesh {
        let cell = if tol > 0.0 { tol * 2.0 } else { 1e-12 };
        let key = |p: V3| p.map(|c| (c / cell).floor() as i64);
        let mut grid: HashMap<[i64; 3], Vec<u32>> = HashMap::with_capacity(self.positions.len());
        let mut remap = vec![u32::MAX; self.positions.len()];
        let mut out = Vec::with_capacity(self.positions.len());
        let tol2 = tol * tol;
        let mut used = vec![false; self.positions.len()];
        for &i in self.triangles.iter().flatten() {
            used[i as usize] = true;
        }
        for (i, &p) in self.positions.iter().enumerate() {
            if !used[i] {
                continue;
            }
            let k = key(p);
            let mut found = None;
            'search: for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        if let Some(list) = grid.get(&[k[0] + dx, k[1] + dy, k[2] + dz]) {
                            for &j in list {
                                let d = vec3::sub(p, out[j as usize]);
                                if vec3::dot(d, d) <= tol2 {
                                    found = Some(j);
                                    break 'search;
                                }
                            }
                        }
                    }
                }
            }
            remap[i] = found.unwrap_or_else(|| {
                let j = out.len() as u32;
                out.push(p);
                grid.entry(k).or_default().push(j);
                j
            });
        }
        self.remapped(out, &remap)
    }

    /// The welded mesh from the kept positions and each old vertex's new index; triangles that collapse go.
    fn remapped(&self, out: Vec<V3>, remap: &[u32]) -> TriMesh {
        let mapped: Vec<[u32; 3]> = self
            .triangles
            .iter()
            .map(|t| t.map(|i| remap[i as usize]))
            .collect();
        let keep = |t: &[u32; 3]| t[0] != t[1] && t[1] != t[2] && t[0] != t[2];
        let faces = self.faces.as_ref().map(|f| f.retained(|i| keep(&mapped[i])));
        TriMesh {
            positions: out,
            triangles: mapped.into_iter().filter(keep).collect(),
            faces,
        }
    }

    #[must_use]
    pub fn welded(&self) -> TriMesh {
        self.weld(weld_tolerance(self.bounds()))
    }

    /// `weld(0.0)`: corners at the same point become one, in the order they are first used, with one lookup per corner
    /// (the tolerance weld searches the 27 cells around it). -0 is the same point as 0; a corner that is not a number
    /// is never the same point as another, as the tolerance weld's distance test has it.
    fn weld_exact(&self) -> TriMesh {
        let mut used = vec![false; self.positions.len()];
        for &i in self.triangles.iter().flatten() {
            used[i as usize] = true;
        }
        let mut seen: HashMap<[u64; 3], u32> = HashMap::with_capacity(self.positions.len());
        let mut remap = vec![u32::MAX; self.positions.len()];
        let mut out: Vec<V3> = Vec::with_capacity(self.positions.len());
        for (i, &p) in self.positions.iter().enumerate() {
            if !used[i] {
                continue;
            }
            #[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
            let next = out.len() as u32;
            remap[i] = if p.iter().any(|c| c.is_nan()) {
                out.push(p);
                next
            } else {
                *seen.entry(p.map(|c| (c + 0.0).to_bits())).or_insert_with(|| {
                    out.push(p);
                    next
                })
            };
        }
        self.remapped(out, &remap)
    }

    pub fn edge_report(&self) -> EdgeReport {
        let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::with_capacity(self.triangles.len() * 2);
        for t in &self.triangles {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
                if a < b {
                    e.0 += 1;
                } else {
                    e.1 += 1;
                }
            }
        }
        let mut r = EdgeReport::default();
        for &(fwd, back) in edges.values() {
            match fwd + back {
                1 => r.boundary_edges += 1,
                2 if fwd != 1 => r.flipped_edges += 1,
                2 => {}
                _ => r.non_manifold_edges += 1,
            }
        }
        r
    }

    pub fn components(&self) -> Vec<TriMesh> {
        fn find(parent: &mut [u32], mut x: u32) -> u32 {
            while parent[x as usize] != x {
                let up = parent[parent[x as usize] as usize];
                parent[x as usize] = up;
                x = up;
            }
            x
        }
        let n = self.positions.len();
        let mut parent: Vec<u32> = (0..u32::try_from(n).unwrap_or(u32::MAX)).collect();
        for t in &self.triangles {
            let a = find(&mut parent, t[0]);
            for &i in &t[1..] {
                let b = find(&mut parent, i);
                if a != b {
                    parent[b as usize] = a;
                }
            }
        }
        let mut groups: HashMap<u32, Vec<usize>> = HashMap::new();
        let mut order = Vec::new();
        for (i, t) in self.triangles.iter().enumerate() {
            let r = find(&mut parent, t[0]);
            groups
                .entry(r)
                .or_insert_with(|| {
                    order.push(r);
                    Vec::new()
                })
                .push(i);
        }
        let mut out: Vec<TriMesh> = order
            .into_iter()
            .filter_map(|r| groups.remove(&r))
            .map(|idx| self.subset_of(&idx))
            .collect();
        out.sort_by_key(|m| std::cmp::Reverse(m.triangles.len()));
        out
    }

    /// The triangles at `idx` (in that order) with only the vertices they use, and their faces.
    #[must_use]
    pub fn subset_of(&self, idx: &[usize]) -> TriMesh {
        let tris: Vec<[u32; 3]> = idx.iter().map(|&i| self.triangles[i]).collect();
        let mut out = self.subset(&tris);
        out.faces = self.faces.as_ref().map(|f| {
            Faces {
                ids: idx.iter().map(|&i| f.ids[i]).collect(),
                table: f.table.clone(),
                keys: f.keys.clone(),
            }
            .compacted()
        });
        out
    }

    /// These triangles with only the vertices they use. They carry no faces; `subset_of` keeps them.
    #[must_use]
    pub fn subset(&self, tris: &[[u32; 3]]) -> TriMesh {
        let mut remap: HashMap<u32, u32> = HashMap::new();
        let mut out = TriMesh::default();
        for t in tris {
            let t2 = t.map(|i| {
                *remap
                    .entry(i)
                    .or_insert_with(|| out.push_vertex(self.positions[i as usize]))
            });
            out.triangles.push(t2);
        }
        out
    }

    pub fn from_stl(bytes: &[u8], name: &str) -> Result<Self> {
        let soup = if is_ascii_stl(bytes) {
            read_ascii_stl(bytes, name)?
        } else {
            read_binary_stl(bytes, name)?
        };
        let m = TriMesh {
            triangles: (0..soup.len() / 3)
                .map(|t| {
                    #[allow(clippy::cast_possible_truncation, reason = "checked by the STL readers")]
                    let i = (t * 3) as u32;
                    [i, i + 1, i + 2]
                })
                .collect(),
            positions: soup,
            faces: None,
        };
        Ok(m.weld(0.0))
    }

    #[allow(clippy::cast_possible_truncation, reason = "STL stores f32 and a u32 count")]
    pub fn to_stl(&self, header: &str) -> Vec<u8> {
        let mut out = Vec::with_capacity(84 + self.triangles.len() * 50);
        let mut h = [0u8; 80];
        for (d, s) in h.iter_mut().zip(header.bytes()) {
            *d = s;
        }
        out.extend_from_slice(&h);
        out.extend_from_slice(&(self.triangles.len() as u32).to_le_bytes());
        for &t in &self.triangles {
            let n = self.normal(t);
            for c in n.iter().chain(self.corners(t).iter().flatten()) {
                out.extend_from_slice(&(*c as f32).to_le_bytes());
            }
            out.extend_from_slice(&[0, 0]);
        }
        out
    }
}

fn is_ascii_stl(bytes: &[u8]) -> bool {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(0);
    let head = bytes.get(start..).unwrap_or(&[]);
    if !head.starts_with(b"solid") {
        return false;
    }
    if bytes.len() >= 84 {
        let n = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
        if 84 + n * 50 == bytes.len() {
            return false;
        }
    }
    true
}

fn read_binary_stl(bytes: &[u8], name: &str) -> Result<Vec<V3>> {
    let count = bytes
        .get(80..84)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
        .ok_or_else(|| Error::mesh(name, "STL shorter than its header"))?;
    let body = bytes
        .get(84..)
        .filter(|b| b.len() >= count.saturating_mul(50))
        .ok_or_else(|| Error::mesh(name, format!("STL declares {count} triangles but is truncated")))?;
    if count > (u32::MAX / 3) as usize {
        return Err(Error::mesh(name, "too many triangles"));
    }
    let mut out = Vec::with_capacity(count * 3);
    for rec in body.as_chunks::<50>().0.iter().take(count) {
        for v in 0..3 {
            let at = 12 + v * 12;
            let f = |o: usize| {
                f64::from(f32::from_le_bytes([
                    rec[at + o],
                    rec[at + o + 1],
                    rec[at + o + 2],
                    rec[at + o + 3],
                ]))
            };
            out.push([f(0), f(4), f(8)]);
        }
    }
    if out.iter().flatten().any(|c| !c.is_finite()) {
        return Err(Error::mesh(name, "STL has non-finite coordinates"));
    }
    Ok(out)
}

fn read_ascii_stl(bytes: &[u8], name: &str) -> Result<Vec<V3>> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = Vec::new();
    let mut words = text.split_ascii_whitespace();
    while let Some(w) = words.next() {
        if w.eq_ignore_ascii_case("vertex") {
            let mut p = [0.0; 3];
            for c in &mut p {
                *c = words
                    .next()
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| v.is_finite())
                    .ok_or_else(|| Error::mesh(name, "bad vertex in ASCII STL"))?;
            }
            out.push(p);
        }
    }
    if out.len() % 3 != 0 {
        return Err(Error::mesh(name, "ASCII STL vertex count is not a multiple of 3"));
    }
    if out.len() / 3 > (u32::MAX / 3) as usize {
        return Err(Error::mesh(name, "too many triangles"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    #[test]
    fn cube_is_watertight_with_unit_volume() {
        let m = build::box_mesh([0.0; 3], [1.0, 2.0, 3.0]);
        assert!(m.edge_report().is_watertight());
        assert!((m.volume() - 6.0).abs() < 1e-12);
        assert!((m.area() - 22.0).abs() < 1e-12);
    }

    #[test]
    fn stl_round_trip_keeps_topology() {
        let m = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        let back = TriMesh::from_stl(&m.to_stl("test"), "cube.stl").unwrap();
        assert_eq!(back.triangles.len(), 12);
        assert_eq!(back.positions.len(), 8);
        assert!(back.edge_report().is_watertight());
    }

    #[test]
    fn weld_merges_close_vertices() {
        let mut m = TriMesh::default();
        m.push_triangle([0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
        m.push_triangle([1.0 + 1e-9, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]);
        let w = m.weld(1e-6);
        assert_eq!(w.positions.len(), 4);
    }

    #[test]
    fn bad_index_is_rejected() {
        assert!(TriMesh::from_flat(&[0.0; 9], &[0, 1, 3]).is_err());
    }

    #[test]
    #[allow(clippy::cast_precision_loss, reason = "small test counts")]
    fn the_exact_weld_matches_the_grid_weld_at_tolerance_zero() {
        // A soup with repeated corners, -0 beside 0, points a hair apart, an unused vertex, a triangle that collapses
        // and corners that are not numbers: one lookup per corner gives what the 27-cell search gives.
        let mut m = TriMesh::default();
        let mut x = 0.37_f64;
        for i in 0..400 {
            x = (x * 3.9).fract();
            let p = [
                f64::from(i % 7) * 0.5,
                (x * 4.0).floor() * 0.25,
                if i % 5 == 0 { -0.0 } else { 0.0 },
            ];
            let q = [p[0] + 1e-13, p[1], p[2]];
            let r = [p[0], p[1] + 0.25, 1.0];
            m.push_triangle(p, if i % 3 == 0 { q } else { r }, [p[0] + 0.5, p[1], p[2]]);
        }
        m.push_triangle([0.0; 3], [0.0; 3], [1.0, 0.0, 0.0]);
        m.push_triangle([f64::NAN, 0.0, 0.0], [f64::NAN, 0.0, 0.0], [2.0, 2.0, 2.0]);
        m.positions.push([9.0, 9.0, 9.0]);
        let (exact, grid) = (m.weld(0.0), m.weld_grid(0.0));
        assert_eq!(exact.triangles, grid.triangles);
        assert_eq!(exact.positions.len(), grid.positions.len());
        for (a, b) in exact.positions.iter().zip(&grid.positions) {
            for k in 0..3 {
                assert!(
                    a[k].to_bits() == b[k].to_bits() || (a[k].is_nan() && b[k].is_nan()),
                    "{a:?} against {b:?}"
                );
            }
        }
        assert!(exact.positions.len() < 3 * m.triangles.len());
    }
}
