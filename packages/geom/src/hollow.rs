// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! hollowing with a wall thickness and drain holes
// grid indices are computed from the grid dimensions and stay in range; the
// per-vertex and per-triangle indices come from meshes this module builds
#![allow(clippy::indexing_slicing)]

use crate::convex::{ConvexSolid, subtract};
use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::mesh::{Aabb, TriMesh};
use crate::vec3::{self, Frame, Plane, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const AUTO_MAX_CELLS: f64 = 2.0e6;
const HARD_MAX_CELLS: f64 = 32.0e6;
/// stand-in for infinity in the squared distance transform
const FAR: f64 = 1.0e12;
const HOLE_SIDES: usize = 24;
/// sample offsets (fractions of a voxel) that keep column rays off triangle edges, so shared edges are never hit twice or missed
const JITTER: [f64; 2] = [0.000_137, 0.000_291];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainHole {
    pub point: V3,
    #[serde(default)]
    pub direction: Option<V3>,
    #[serde(default = "default_hole_diameter")]
    pub diameter_mm: f64,
}

fn default_hole_diameter() -> f64 {
    3.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HollowOptions {
    pub wall_mm: f64,
    pub voxel_mm: Option<f64>,
    pub drain_holes: Vec<DrainHole>,
    pub smooth_iterations: u32,
}

impl Default for HollowOptions {
    fn default() -> Self {
        Self {
            wall_mm: 2.0,
            voxel_mm: None,
            drain_holes: Vec::new(),
            smooth_iterations: 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HollowReport {
    pub inner_triangles: usize,
    pub volume_before_mm3: f64,
    pub volume_after_mm3: f64,
    pub material_saved_percent: f64,
    pub voxel_mm: f64,
    pub grid: [usize; 3],
    pub drain_holes: usize,
}

struct Grid {
    n: [usize; 3],
    h: f64,
    origin: V3,
}

impl Grid {
    fn new(b: Aabb, h: f64) -> Self {
        let size = b.size();
        let n = size.map(|s| cells_along(s, h) + 4);
        Self {
            n,
            h,
            origin: b.min.map(|m| m - 2.0 * h),
        }
    }

    fn cells(&self) -> f64 {
        self.n.iter().map(|&n| n as f64).product()
    }

    fn idx(&self, i: usize, j: usize, k: usize) -> usize {
        i + self.n[0] * (j + self.n[1] * k)
    }

    fn center(&self, i: usize, j: usize, k: usize) -> V3 {
        [
            self.origin[0] + (i as f64 + 0.5) * self.h,
            self.origin[1] + (j as f64 + 0.5) * self.h,
            self.origin[2] + (k as f64 + 0.5) * self.h,
        ]
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "size over voxel is small and positive"
)]
fn cells_along(size: f64, h: f64) -> usize {
    (size / h).ceil().max(1.0) as usize
}

/// hollows `mesh` to a shell of `opts.wall_mm`, then cuts the drain holes.
///
/// a wall thicker than half the part leaves no cavity, and the input comes
/// back unchanged with `inner_triangles == 0`.
///
/// # Errors
/// Invalid options, a mesh that is empty or has bad indices, a grid beyond
/// the size limit, or a failure while cutting a drain hole.
#[allow(
    clippy::cast_possible_truncation,
    reason = "vertex counts are checked below 2^32"
)]
pub fn hollow(mesh: &TriMesh, opts: &HollowOptions) -> Result<(TriMesh, HollowReport)> {
    mesh.validate("hollow")?;
    if !(opts.wall_mm.is_finite() && opts.wall_mm > 0.0) {
        return Err(Error::invalid("wallMm", "must be a positive number"));
    }
    if let Some(v) = opts.voxel_mm
        && !(v.is_finite() && v > 0.0)
    {
        return Err(Error::invalid("voxelMm", "must be a positive number"));
    }
    for hole in &opts.drain_holes {
        if !(hole.diameter_mm.is_finite() && hole.diameter_mm > 0.0) {
            return Err(Error::invalid("diameterMm", "must be a positive number"));
        }
    }
    let bounds = mesh
        .bounds()
        .ok_or_else(|| Error::mesh("hollow", "the mesh is empty"))?;
    let grid = choose_grid(bounds, opts)?;
    let volume_before = mesh.volume();

    let inside = voxelize(mesh, &grid);
    let field = depth_field(&inside, &grid, opts.wall_mm);
    let mut inner = extract_surface(&field, &grid);
    smooth(&mut inner, opts.smooth_iterations);
    drop_small_components(&mut inner, 64.0 * grid.h.m_powi(3));

    let mut out = mesh.clone();
    let mut holes = 0;
    if !inner.triangles.is_empty() {
        out.append(&inner);
        for hole in &opts.drain_holes {
            out = cut_hole(&out, mesh, hole, opts.wall_mm)?;
            holes += 1;
        }
    }
    let volume_after = out.volume();
    let saved = if volume_before > 0.0 {
        100.0 * (volume_before - volume_after) / volume_before
    } else {
        0.0
    };
    let report = HollowReport {
        inner_triangles: inner.triangles.len(),
        volume_before_mm3: volume_before,
        volume_after_mm3: volume_after,
        material_saved_percent: saved,
        voxel_mm: grid.h,
        grid: grid.n,
        drain_holes: holes,
    };
    Ok((out, report))
}

fn choose_grid(bounds: Aabb, opts: &HollowOptions) -> Result<Grid> {
    if let Some(h) = opts.voxel_mm {
        let g = Grid::new(bounds, h);
        if g.cells() > HARD_MAX_CELLS {
            return Err(Error::invalid(
                "voxelMm",
                format!("the grid would have {:.0} cells; use a larger voxel", g.cells()),
            ));
        }
        return Ok(g);
    }
    let mut h = opts.wall_mm / 3.0;
    // coarsening changes the margin too, so a few passes settle on a size
    for _ in 0..8 {
        let g = Grid::new(bounds, h);
        if g.cells() <= AUTO_MAX_CELLS {
            return Ok(g);
        }
        h *= (g.cells() / AUTO_MAX_CELLS).m_cbrt().max(1.01);
    }
    Ok(Grid::new(bounds, h))
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "indices are clamped to the grid before conversion"
)]
fn voxelize(mesh: &TriMesh, g: &Grid) -> Vec<bool> {
    let [nx, ny, nz] = g.n;
    let mut columns: Vec<Vec<f64>> = vec![Vec::new(); nx * ny];
    let range = |lo: f64, hi: f64, origin: f64, jitter: f64, n: usize| -> Option<(usize, usize)> {
        let a = ((lo - origin) / g.h - 0.5 - jitter).ceil().max(0.0);
        let b = ((hi - origin) / g.h - 0.5 - jitter).floor().min(n as f64 - 1.0);
        (a <= b).then_some((a as usize, b as usize))
    };
    for &t in &mesh.triangles {
        let [a, b, c] = mesh.corners(t);
        let area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if area2.abs() < 1e-18 {
            continue;
        }
        let Some((i0, i1)) = range(
            a[0].min(b[0]).min(c[0]),
            a[0].max(b[0]).max(c[0]),
            g.origin[0],
            JITTER[0],
            nx,
        ) else {
            continue;
        };
        let Some((j0, j1)) = range(
            a[1].min(b[1]).min(c[1]),
            a[1].max(b[1]).max(c[1]),
            g.origin[1],
            JITTER[1],
            ny,
        ) else {
            continue;
        };
        for j in j0..=j1 {
            let py = g.origin[1] + (j as f64 + 0.5 + JITTER[1]) * g.h;
            for i in i0..=i1 {
                let px = g.origin[0] + (i as f64 + 0.5 + JITTER[0]) * g.h;
                let w0 = (b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px);
                let w1 = (c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px);
                let w2 = area2 - w0 - w1;
                if w0 * area2 > 0.0 && w1 * area2 > 0.0 && w2 * area2 > 0.0 {
                    columns[i + nx * j].push((w0 * a[2] + w1 * b[2] + w2 * c[2]) / area2);
                }
            }
        }
    }
    let mut inside = vec![false; nx * ny * nz];
    let to_k = |z: f64| ((z - g.origin[2]) / g.h - 0.5).ceil();
    for (col, zs) in columns.iter_mut().enumerate() {
        zs.sort_by(f64::total_cmp);
        // an odd crossing count means an open mesh; the unpaired last one is dropped
        #[allow(
            clippy::chunks_exact_to_as_chunks,
            reason = "as_chunks is too new for the pinned MSRV"
        )]
        for pair in zs.chunks_exact(2) {
            let k0 = to_k(pair[0]).max(0.0);
            let k1 = (to_k(pair[1]) - 1.0).min(nz as f64 - 1.0);
            let mut k = k0;
            while k <= k1 {
                inside[col + nx * ny * (k as usize)] = true;
                k += 1.0;
            }
        }
    }
    inside
}

fn edt_line(f: &[f64], out: &mut [f64], v: &mut [usize], z: &mut [f64]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0;
    v[0] = 0;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    for q in 1..n {
        let fq = f[q] + (q * q) as f64;
        let s = loop {
            let p = v[k];
            let s = (fq - (f[p] + (p * p) as f64)) / (2.0 * (q as f64 - p as f64));
            if s <= z[k] {
                k -= 1;
            } else {
                break s;
            }
        };
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f64::INFINITY;
    }
    k = 0;
    for (q, o) in out.iter_mut().enumerate() {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let d = q as f64 - v[k] as f64;
        *o = d * d + f[v[k]];
    }
}

fn depth_field(inside: &[bool], g: &Grid, wall: f64) -> Vec<f64> {
    let [nx, ny, nz] = g.n;
    let mut d2: Vec<f64> = inside.iter().map(|&i| if i { FAR } else { 0.0 }).collect();
    let longest = nx.max(ny).max(nz);
    let mut line = vec![0.0; longest];
    let mut res = vec![0.0; longest];
    let mut v = vec![0usize; longest];
    let mut z = vec![0.0; longest + 1];
    for axis in 0..3 {
        let (len, s0, s1) = match axis {
            0 => (nx, ny, nz),
            1 => (ny, nx, nz),
            _ => (nz, nx, ny),
        };
        for b in 0..s1 {
            for a in 0..s0 {
                let at = |t: usize| match axis {
                    0 => g.idx(t, a, b),
                    1 => g.idx(a, t, b),
                    _ => g.idx(a, b, t),
                };
                for t in 0..len {
                    line[t] = d2[at(t)];
                }
                edt_line(&line[..len], &mut res[..len], &mut v, &mut z);
                for t in 0..len {
                    d2[at(t)] = res[t];
                }
            }
        }
    }
    // 0.4 tuned on a sphere, a cube and a torus (volume within a few percent)
    let bias = 0.4 * g.h;
    d2.iter()
        .zip(inside)
        .map(|(&d, &i)| if i { d.sqrt() * g.h - bias - wall } else { -wall })
        .collect()
}

const TETS: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

struct Corner {
    node: u64,
    pos: V3,
    f: f64,
}

#[derive(Default)]
struct Extractor {
    by_edge: HashMap<(u64, u64), u32>,
    mesh: TriMesh,
}

impl Extractor {
    fn vertex(&mut self, a: &Corner, b: &Corner) -> u32 {
        let (lo, hi) = if a.node < b.node { (a, b) } else { (b, a) };
        if let Some(&i) = self.by_edge.get(&(lo.node, hi.node)) {
            return i;
        }
        let t = lo.f / (lo.f - hi.f);
        let i = self.mesh.push_vertex(vec3::lerp(lo.pos, hi.pos, t));
        self.by_edge.insert((lo.node, hi.node), i);
        i
    }

    fn triangle(&mut self, e: [(&Corner, &Corner); 3], positive: V3) {
        let mid = e.map(|(a, b)| vec3::lerp(a.pos, b.pos, 0.5));
        let n = vec3::tri_normal(mid[0], mid[1], mid[2]);
        let centroid = vec3::scale(vec3::add(vec3::add(mid[0], mid[1]), mid[2]), 1.0 / 3.0);
        let [i, j, k] = e.map(|(a, b)| self.vertex(a, b));
        if vec3::dot(n, vec3::sub(positive, centroid)) >= 0.0 {
            self.mesh.triangles.push([i, j, k]);
        } else {
            self.mesh.triangles.push([i, k, j]);
        }
    }

    fn tetrahedron(&mut self, c: [&Corner; 4]) {
        let pos: Vec<&Corner> = c.iter().copied().filter(|p| p.f > 0.0).collect();
        let neg: Vec<&Corner> = c.iter().copied().filter(|p| p.f <= 0.0).collect();
        let mean = |set: &[&Corner]| {
            let sum = set.iter().fold([0.0; 3], |acc, p| vec3::add(acc, p.pos));
            vec3::scale(sum, 1.0 / set.len() as f64)
        };
        match (pos.as_slice(), neg.as_slice()) {
            ([a], [b, c, d]) => self.triangle([(a, b), (a, c), (a, d)], a.pos),
            ([a, b, c], [d]) => self.triangle([(a, d), (b, d), (c, d)], mean(&[a, b, c])),
            ([p0, p1], [n0, n1]) => {
                let at = mean(&[p0, p1]);
                self.triangle([(p0, n0), (p0, n1), (p1, n1)], at);
                self.triangle([(p0, n0), (p1, n1), (p1, n0)], at);
            }
            _ => {}
        }
    }
}

fn extract_surface(field: &[f64], g: &Grid) -> TriMesh {
    let [nx, ny, nz] = g.n;
    let mut ex = Extractor::default();
    for k in 0..nz - 1 {
        for j in 0..ny - 1 {
            for i in 0..nx - 1 {
                let corners: [Corner; 8] = std::array::from_fn(|c| {
                    let (ci, cj, ck) = (i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2));
                    let node = g.idx(ci, cj, ck);
                    Corner {
                        node: node as u64,
                        pos: g.center(ci, cj, ck),
                        f: field[node],
                    }
                });
                let any_pos = corners.iter().any(|c| c.f > 0.0);
                let any_neg = corners.iter().any(|c| c.f <= 0.0);
                if !(any_pos && any_neg) {
                    continue;
                }
                for t in TETS {
                    ex.tetrahedron(t.map(|c| &corners[c]));
                }
            }
        }
    }
    ex.mesh
}

fn smooth(m: &mut TriMesh, iterations: u32) {
    if iterations == 0 || m.triangles.is_empty() {
        return;
    }
    let mut neighbors: Vec<Vec<u32>> = vec![Vec::new(); m.positions.len()];
    for t in &m.triangles {
        for e in 0..3 {
            let (a, b) = (t[e], t[(e + 1) % 3]);
            neighbors[a as usize].push(b);
            neighbors[b as usize].push(a);
        }
    }
    for list in &mut neighbors {
        list.sort_unstable();
        list.dedup();
    }
    for _ in 0..iterations {
        for lambda in [0.5, -0.53] {
            let next: Vec<V3> = m
                .positions
                .iter()
                .zip(&neighbors)
                .map(|(&p, ns)| {
                    if ns.is_empty() {
                        return p;
                    }
                    let sum = ns
                        .iter()
                        .fold([0.0; 3], |acc, &n| vec3::add(acc, m.positions[n as usize]));
                    let avg = vec3::scale(sum, 1.0 / ns.len() as f64);
                    vec3::add(p, vec3::scale(vec3::sub(avg, p), lambda))
                })
                .collect();
            m.positions = next;
        }
    }
}

fn find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    x
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "vertex counts are checked below 2^32"
)]
fn drop_small_components(m: &mut TriMesh, min_volume: f64) {
    let mut parent: Vec<usize> = (0..m.positions.len()).collect();
    for t in &m.triangles {
        let a = find(&mut parent, t[0] as usize);
        for &v in &t[1..] {
            let b = find(&mut parent, v as usize);
            parent[b] = a;
        }
    }
    let origin = m.bounds().map_or([0.0; 3], |b| b.center());
    let mut volume: HashMap<usize, f64> = HashMap::new();
    for &t in &m.triangles {
        let root = find(&mut parent, t[0] as usize);
        let [a, b, c] = m.corners(t).map(|p| vec3::sub(p, origin));
        *volume.entry(root).or_insert(0.0) += vec3::dot(a, vec3::cross(b, c)) / 6.0;
    }
    let keep = |root: usize| volume.get(&root).is_some_and(|v| v.abs() >= min_volume);
    let mut remap: HashMap<u32, u32> = HashMap::new();
    let mut out = TriMesh::default();
    for &t in &m.triangles {
        if !keep(find(&mut parent, t[0] as usize)) {
            continue;
        }
        let ids = t.map(|v| {
            *remap
                .entry(v)
                .or_insert_with(|| out.push_vertex(m.positions[v as usize]))
        });
        out.triangles.push(ids);
    }
    *m = out;
}

fn closest_point_on_triangle(p: V3, a: V3, b: V3, c: V3) -> V3 {
    let (ab, ac, ap) = (vec3::sub(b, a), vec3::sub(c, a), vec3::sub(p, a));
    let (d1, d2) = (vec3::dot(ab, ap), vec3::dot(ac, ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = vec3::sub(p, b);
    let (d3, d4) = (vec3::dot(ab, bp), vec3::dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return vec3::add(a, vec3::scale(ab, d1 / (d1 - d3)));
    }
    let cp = vec3::sub(p, c);
    let (d5, d6) = (vec3::dot(ab, cp), vec3::dot(ac, cp));
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return vec3::add(a, vec3::scale(ac, d2 / (d2 - d6)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return vec3::add(b, vec3::scale(vec3::sub(c, b), w));
    }
    let denom = 1.0 / (va + vb + vc);
    vec3::add(
        a,
        vec3::add(vec3::scale(ab, vb * denom), vec3::scale(ac, vc * denom)),
    )
}

fn inward_normal(outer: &TriMesh, point: V3) -> Option<V3> {
    let mut best: Option<(f64, V3)> = None;
    for &t in &outer.triangles {
        let [a, b, c] = outer.corners(t);
        let q = closest_point_on_triangle(point, a, b, c);
        let d = vec3::len(vec3::sub(q, point));
        if best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, vec3::tri_normal(a, b, c)));
        }
    }
    let (_, n) = best?;
    vec3::normalize(vec3::scale(n, -1.0))
}

fn cut_hole(mesh: &TriMesh, outer: &TriMesh, hole: &DrainHole, wall: f64) -> Result<TriMesh> {
    let axis = hole
        .direction
        .and_then(vec3::normalize)
        .or_else(|| inward_normal(outer, hole.point))
        .ok_or_else(|| Error::invalid("drainHoles", "no hole direction and no surface to take it from"))?;
    let frame = Frame::from_normal(vec3::sub(hole.point, axis), axis, None)
        .ok_or_else(|| Error::invalid("drainHoles", "the hole direction is zero"))?;
    // start 1 mm outside the part, end 2 mm past the wall so a slanted cut still reaches
    let depth = 1.0 + wall + 2.0;
    let r = hole.diameter_mm / 2.0;
    let apothem = r * (std::f64::consts::PI / HOLE_SIDES as f64).m_cos();
    let mut planes = Vec::with_capacity(HOLE_SIDES + 2);
    for s in 0..HOLE_SIDES {
        let a = std::f64::consts::TAU * (s as f64 + 0.5) / HOLE_SIDES as f64;
        let normal = vec3::add(vec3::scale(frame.u, a.m_cos()), vec3::scale(frame.v, a.m_sin()));
        planes.push(Plane {
            normal,
            offset: vec3::dot(normal, frame.origin) + apothem,
        });
    }
    let bottom = Plane::new(frame.origin, vec3::scale(axis, -1.0))
        .ok_or_else(|| Error::invalid("drainHoles", "the hole direction is zero"))?;
    let top = Plane::new(vec3::add(frame.origin, vec3::scale(axis, depth)), axis)
        .ok_or_else(|| Error::invalid("drainHoles", "the hole direction is zero"))?;
    planes.push(bottom);
    planes.push(top);
    subtract(mesh, &ConvexSolid { planes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;
    use std::f64::consts::PI;
    use std::time::Instant;

    fn shell_check(m: &TriMesh, before: f64, expect_after: f64, tol: f64) {
        let w = m.welded();
        let r = w.edge_report();
        assert!(r.is_watertight(), "{r:?}");
        let after = w.volume();
        assert!(before > after);
        assert!(
            (after - expect_after).abs() / expect_after < tol,
            "volume {after} vs expected {expect_after}"
        );
    }

    #[test]
    fn sphere_matches_analytic_shell() {
        let s = build::uv_sphere([5.0, -3.0, 20.0], 20.0, 48, 96);
        let t0 = Instant::now();
        let (out, rep) = hollow(&s, &HollowOptions::default()).unwrap();
        eprintln!(
            "sphere grid {:?} voxel {:.3} in {:?}",
            rep.grid,
            rep.voxel_mm,
            t0.elapsed()
        );
        let shell = 4.0 / 3.0 * PI * (20.0f64.m_powi(3) - 18.0f64.m_powi(3));
        let expect = s.volume() * shell / (4.0 / 3.0 * PI * 8000.0);
        shell_check(&out, s.volume(), expect, 0.06);
        assert!(rep.inner_triangles > 0);
        assert!(rep.material_saved_percent > 50.0);
    }

    #[test]
    fn cube_keeps_a_uniform_wall() {
        let c = build::box_mesh([0.0; 3], [30.0; 3]);
        let (out, rep) = hollow(&c, &HollowOptions::default()).unwrap();
        let expect = 30.0f64.m_powi(3) - 26.0f64.m_powi(3);
        shell_check(&out, c.volume(), expect, 0.06);
        assert!(rep.volume_after_mm3 < rep.volume_before_mm3);
    }

    #[test]
    fn torus_is_watertight() {
        let t = build::torus([0.0; 3], 20.0, 6.0, 150, 100);
        let t0 = Instant::now();
        let (out, rep) = hollow(&t, &HollowOptions::default()).unwrap();
        eprintln!(
            "torus grid {:?} voxel {:.3} in {:?}",
            rep.grid,
            rep.voxel_mm,
            t0.elapsed()
        );
        let expect = 2.0 * PI * PI * 20.0 * (6.0f64.m_powi(2) - 4.0f64.m_powi(2));
        shell_check(&out, t.volume(), expect, 0.08);
    }

    #[test]
    fn wall_thicker_than_the_part_returns_the_input() {
        let c = build::box_mesh([0.0; 3], [10.0; 3]);
        let opts = HollowOptions {
            wall_mm: 6.0,
            ..HollowOptions::default()
        };
        let (out, rep) = hollow(&c, &opts).unwrap();
        assert_eq!(out, c);
        assert_eq!(rep.inner_triangles, 0);
        assert!(rep.material_saved_percent.abs() < 1e-9);
    }

    #[test]
    fn rejects_bad_options() {
        let c = build::box_mesh([0.0; 3], [10.0; 3]);
        let bad = HollowOptions {
            wall_mm: 0.0,
            ..HollowOptions::default()
        };
        assert!(hollow(&c, &bad).is_err());
    }

    #[test]
    fn options_read_from_partial_json() {
        let o: HollowOptions =
            serde_json::from_str(r#"{"wallMm":1.5,"drainHoles":[{"point":[0,0,0]}]}"#).unwrap();
        assert!((o.wall_mm - 1.5).abs() < 1e-12);
        assert_eq!(o.smooth_iterations, 2);
        assert!((o.drain_holes[0].diameter_mm - 3.0).abs() < 1e-12);
    }

    #[test]
    fn drain_hole_opens_the_cavity() {
        let s = build::uv_sphere([0.0; 3], 20.0, 48, 96);
        let opts = HollowOptions {
            drain_holes: vec![DrainHole {
                point: [0.0, 0.0, -20.0],
                direction: None,
                diameter_mm: 4.0,
            }],
            ..HollowOptions::default()
        };
        let (plain, _) = hollow(&s, &HollowOptions::default()).unwrap();
        let (out, rep) = hollow(&s, &opts).unwrap();
        assert_eq!(rep.drain_holes, 1);
        let w = out.welded();
        assert!(w.edge_report().is_watertight());
        let removed = plain.volume() - w.volume();
        let cylinder = PI * 4.0 * 2.0;
        assert!(
            removed > 0.5 * cylinder && removed < 2.0 * cylinder,
            "removed {removed}"
        );
    }
}
