// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! text and logo emboss or deboss onto a flat face
// indices come from the validated mesh, from loops built in this module and
// from ring lengths checked before use
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::font;
use crate::mesh::{TriMesh, weld_tolerance};
use crate::poly2d::{self, Polygon};
use crate::vec3::{self, Frame, V2, V3};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmbossMode {
    Emboss,
    Deboss,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbossSpec {
    pub text: String,
    pub point: V3,
    #[serde(default)]
    pub normal: Option<V3>,
    #[serde(default)]
    pub up: Option<V3>,
    pub size_mm: f64,
    /// stroke thickness in millimeters. defaults to `size_mm * 0.16`.
    #[serde(default)]
    pub stroke_mm: Option<f64>,
    pub depth_mm: f64,
    pub mode: EmbossMode,
}

const MARGIN_MM: f64 = 0.05;
const MIN_FLOOR_MM: f64 = 0.2;
const COPLANAR_DEG: f64 = 0.5;
const PLANE_TOL_MM: f64 = 1e-3;

pub fn emboss_text(mesh: &TriMesh, spec: &EmbossSpec) -> Result<TriMesh> {
    if !(spec.size_mm.is_finite() && spec.size_mm > 0.0) {
        return Err(Error::invalid("emboss", "text size must be positive"));
    }
    let stroke = spec.stroke_mm.unwrap_or(spec.size_mm * 0.16);
    if !(stroke.is_finite() && stroke > 0.0) {
        return Err(Error::invalid("emboss", "stroke width must be positive"));
    }
    let polys = font::text_polygons(&spec.text, spec.size_mm, stroke);
    if polys.is_empty() {
        return Err(Error::invalid("emboss", "text has no visible characters"));
    }
    emboss_polygons(
        mesh,
        &polys,
        spec.point,
        spec.normal,
        spec.up,
        spec.depth_mm,
        spec.mode,
    )
}

pub fn emboss_polygons(
    mesh: &TriMesh,
    polys: &[Polygon],
    point: V3,
    normal: Option<V3>,
    up: Option<V3>,
    depth_mm: f64,
    mode: EmbossMode,
) -> Result<TriMesh> {
    if !(depth_mm.is_finite() && depth_mm > 0.0) {
        return Err(Error::invalid("emboss", "depth must be positive"));
    }
    let polys = clean_polygons(polys)?;
    let face = Face::find(mesh, point, normal, up)?;
    face.build(&polys, &Fill::Text { mode, depth_mm })
}

pub fn attach_solid(mesh: &TriMesh, solid: &TriMesh, point: V3, normal: Option<V3>) -> Result<TriMesh> {
    let face = Face::find(mesh, point, normal, None)?;
    let (polys, rest) = face.split_bottom(solid)?;
    face.build(&polys, &Fill::Solid(&rest))
}

enum Fill<'a> {
    Text { mode: EmbossMode, depth_mm: f64 },
    Solid(&'a TriMesh),
}

struct Face {
    base: TriMesh,
    edges: EdgeMap,
    in_region: Vec<bool>,
    frame: Frame,
}

impl Face {
    fn find(mesh: &TriMesh, point: V3, normal: Option<V3>, up: Option<V3>) -> Result<Self> {
        if !point.iter().all(|c| c.is_finite()) {
            return Err(Error::invalid("emboss", "point must be finite"));
        }
        mesh.validate("emboss")?;
        let base = mesh.welded();
        let seed = find_seed(&base, point, normal)?;
        let [a, b, c] = base.corners(base.triangles[seed]);
        let w = vec3::normalize(vec3::tri_normal(a, b, c))
            .ok_or_else(|| Error::geometry("emboss", "no usable face near the point"))?;
        let centroid = vec3::scale(vec3::add(vec3::add(a, b), c), 1.0 / 3.0);
        let edges = edge_map(&base);
        let in_region = flood_within(
            &base,
            &edges,
            seed,
            w,
            centroid,
            COPLANAR_DEG.to_radians().m_cos(),
            PLANE_TOL_MM,
        );
        let origin = vec3::sub(point, vec3::scale(w, vec3::dot(w, vec3::sub(point, centroid))));
        let frame = face_frame(origin, w, up);
        Ok(Self {
            base,
            edges,
            in_region,
            frame,
        })
    }

    fn split_bottom(&self, solid: &TriMesh) -> Result<(Vec<Polygon>, TriMesh)> {
        let f = &self.frame;
        let tol = weld_tolerance(solid.bounds()).max(PLANE_TOL_MM * 1e-3);
        let on_plane = |t: &[u32; 3]| {
            t.iter()
                .all(|&i| f.height(solid.positions[i as usize]).abs() <= tol)
                && vec3::dot(solid.normal(*t), f.w) < 0.0
        };
        let mut rest = TriMesh {
            positions: solid.positions.clone(),
            triangles: Vec::new(),
        };
        let mut cap: Vec<(u32, u32)> = Vec::new();
        for t in &solid.triangles {
            if on_plane(t) {
                cap.extend((0..3).map(|k| (t[k], t[(k + 1) % 3])));
            } else {
                rest.triangles.push(*t);
            }
        }
        let set: HashSet<(u32, u32)> = cap.iter().copied().collect();
        let mut next: HashMap<u32, u32> = HashMap::new();
        for &(a, b) in &cap {
            if !set.contains(&(b, a)) {
                next.insert(a, b);
            }
        }
        let mut rings: Vec<Vec<V2>> = Vec::new();
        while let Some((&start, _)) = next.iter().next() {
            let mut ring = Vec::new();
            let mut at = start;
            while let Some(n) = next.remove(&at) {
                ring.push(f.project(solid.positions[at as usize]));
                at = n;
                if at == start {
                    break;
                }
            }
            if ring.len() >= 3 {
                rings.push(ring);
            }
        }
        if rings.is_empty() {
            return Err(Error::geometry(
                "attach",
                "the solid has no flat bottom on the face plane",
            ));
        }
        Ok((poly2d::nest(rings), rest))
    }

    fn build(&self, polys: &[Polygon], fill: &Fill<'_>) -> Result<TriMesh> {
        let (base, edges, in_region, frame) = (&self.base, &self.edges, &self.in_region, &self.frame);
        let full = region_polygons(base, edges, in_region, frame)?;
        check_fit(&full, polys)?;
        let (region, owner, removed) = select_region(base, edges, in_region, frame, polys, full)?;
        let h = match fill {
            Fill::Text { mode, depth_mm } => {
                let sign = if *mode == EmbossMode::Emboss { 1.0 } else { -1.0 };
                if *mode == EmbossMode::Deboss {
                    check_thickness(base, in_region, frame, polys, *depth_mm)?;
                }
                sign * depth_mm
            }
            Fill::Solid(_) => 0.0,
        };
        let mut out = TriMesh {
            positions: base.positions.clone(),
            triangles: base
                .triangles
                .iter()
                .zip(&removed)
                .filter(|(_, r)| !**r)
                .map(|(t, _)| *t)
                .collect(),
        };
        let text = matches!(fill, Fill::Text { .. });
        let rings: Vec<Vec<TextRing>> = polys
            .iter()
            .map(|p| {
                std::iter::once(&p.outer)
                    .chain(&p.holes)
                    .map(|r| TextRing::new(&mut out, frame, r, h, text))
                    .collect()
            })
            .collect();

        for (k, rp) in region.iter().enumerate() {
            let (mut poly, mut ids) = rp.polygon();
            for (j, _) in owner.iter().enumerate().filter(|(_, o)| **o == k) {
                let outer = &rings[j][0];
                poly.holes.push(polys[j].outer.iter().rev().copied().collect());
                ids.extend(outer.l0.iter().rev());
            }
            push_tris(&mut out, &poly, &ids)?;
        }
        for (p, rs) in polys.iter().zip(&rings) {
            for (hole, ring) in p.holes.iter().zip(rs.iter().skip(1)) {
                let island = Polygon::simple(hole.iter().rev().copied().collect());
                let ids: Vec<u32> = ring.l0.iter().rev().copied().collect();
                push_tris(&mut out, &island, &ids)?;
            }
            if text {
                let ids: Vec<u32> = rs.iter().flat_map(|r| r.lh.iter().copied()).collect();
                push_tris(&mut out, p, &ids)?;
                for r in rs {
                    r.push_walls(&mut out);
                }
            }
        }
        if let Fill::Solid(solid) = fill {
            out.append(solid);
        }
        let tol = weld_tolerance(out.bounds());
        Ok(out.weld(tol))
    }
}

pub fn merge_coplanar(mesh: &TriMesh) -> Result<TriMesh> {
    mesh.validate("merge_coplanar")?;
    let base = mesh.welded();
    let tol = weld_tolerance(base.bounds()) * 100.0;
    let cos_tol = (0.001_f64).to_radians().m_cos();
    let edges = edge_map(&base);
    let mut done = vec![false; base.triangles.len()];
    let mut out = TriMesh {
        positions: base.positions.clone(),
        triangles: Vec::new(),
    };
    for seed in 0..base.triangles.len() {
        if done[seed] {
            continue;
        }
        let [a, b, c] = base.corners(base.triangles[seed]);
        let Some(w) = vec3::normalize(vec3::tri_normal(a, b, c)) else {
            done[seed] = true;
            continue;
        };
        let centroid = vec3::scale(vec3::add(vec3::add(a, b), c), 1.0 / 3.0);
        let region = flood_within(&base, &edges, seed, w, centroid, cos_tol, tol);
        let members: Vec<usize> = (0..region.len()).filter(|&t| region[t]).collect();
        for &t in &members {
            done[t] = true;
        }
        let keep = |out: &mut TriMesh| out.triangles.extend(members.iter().map(|&t| base.triangles[t]));
        if members.len() < 4 {
            keep(&mut out);
            continue;
        }
        let frame = face_frame(centroid, w, None);
        let rebuilt = region_polygons(&base, &edges, &region, &frame).and_then(|polys| {
            let mut tris = TriMesh::default();
            for rp in &polys {
                let (poly, ids) = rp.polygon();
                push_tris(&mut tris, &poly, &ids)?;
            }
            Ok(tris.triangles)
        });
        match rebuilt {
            Ok(t) if !t.is_empty() && t.len() <= members.len() => out.triangles.extend(t),
            _ => keep(&mut out),
        }
    }
    let merged = out.subset(&out.triangles);
    let (before, after) = (base.edge_report(), merged.edge_report());
    let worse = after.boundary_edges > before.boundary_edges
        || after.non_manifold_edges > before.non_manifold_edges
        || after.flipped_edges > before.flipped_edges;
    Ok(if worse { base } else { merged })
}

fn clean_polygons(polys: &[Polygon]) -> Result<Vec<Polygon>> {
    let mut out = Vec::new();
    for p in polys {
        let mut p = p.clone();
        p.holes.retain(|h| h.len() >= 3);
        if p.outer.len() < 3 {
            continue;
        }
        if !p.vertices().all(|v| v.iter().all(|c| c.is_finite())) {
            return Err(Error::invalid("emboss", "polygon has a non-finite coordinate"));
        }
        p.normalize_orientation();
        out.push(p);
    }
    if out.is_empty() {
        return Err(Error::invalid("emboss", "nothing to emboss"));
    }
    for (i, a) in out.iter().enumerate() {
        for (j, b) in out.iter().enumerate() {
            if i != j && b.holes.iter().any(|h| poly2d::point_in_ring(a.outer[0], h)) {
                return Err(Error::invalid(
                    "emboss",
                    "polygons must not nest inside each other's holes",
                ));
            }
        }
    }
    Ok(out)
}

/// multiplicative hasher for small integer keys; the default `SipHash` is the slowest part of a flood fill over 100k edges
#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u32(u32::from(b));
        }
    }
    fn write_u32(&mut self, i: u32) {
        self.0 = (self.0.rotate_left(5) ^ u64::from(i)).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

type EdgeMap = HashMap<(u32, u32), u32, BuildHasherDefault<KeyHasher>>;

#[allow(clippy::cast_possible_truncation, reason = "triangle counts stay below 2^32")]
fn edge_map(m: &TriMesh) -> EdgeMap {
    let mut map = EdgeMap::with_capacity_and_hasher(m.triangles.len() * 3, BuildHasherDefault::default());
    for (i, t) in m.triangles.iter().enumerate() {
        for k in 0..3 {
            map.insert((t[k], t[(k + 1) % 3]), i as u32);
        }
    }
    map
}

fn tri_dist2(p: V3, a: V3, b: V3, c: V3) -> f64 {
    use vec3::{add, dot, scale, sub};
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    let q = if d1 <= 0.0 && d2 <= 0.0 {
        a
    } else {
        let bp = sub(p, b);
        let (d3, d4) = (dot(ab, bp), dot(ac, bp));
        let vc = d1 * d4 - d3 * d2;
        if d3 >= 0.0 && d4 <= d3 {
            b
        } else if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
            add(a, scale(ab, d1 / (d1 - d3)))
        } else {
            let cp = sub(p, c);
            let (d5, d6) = (dot(ab, cp), dot(ac, cp));
            let vb = d5 * d2 - d1 * d6;
            if d6 >= 0.0 && d5 <= d6 {
                c
            } else if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
                add(a, scale(ac, d2 / (d2 - d6)))
            } else {
                let va = d3 * d6 - d5 * d4;
                if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
                    add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))))
                } else {
                    let den = 1.0 / (va + vb + vc);
                    add(a, add(scale(ab, vb * den), scale(ac, vc * den)))
                }
            }
        }
    };
    let d = sub(p, q);
    dot(d, d)
}

fn find_seed(m: &TriMesh, point: V3, normal: Option<V3>) -> Result<usize> {
    let want = normal
        .map(|n| {
            vec3::normalize(n).ok_or_else(|| Error::invalid("emboss", "normal must be a nonzero vector"))
        })
        .transpose()?;
    let mut best: Option<(f64, usize)> = None;
    for (i, &t) in m.triangles.iter().enumerate() {
        let [a, b, c] = m.corners(t);
        let n = vec3::tri_normal(a, b, c);
        let Some(n) = vec3::normalize(n) else { continue };
        if want.is_some_and(|w| vec3::dot(w, n) < 0.9) {
            continue;
        }
        let d = tri_dist2(point, a, b, c);
        if best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, i));
        }
    }
    best.map(|(_, i)| i).ok_or_else(|| {
        Error::geometry(
            "emboss",
            if want.is_some() {
                "no face near the point faces that normal"
            } else {
                "the mesh has no usable triangles"
            },
        )
    })
}

fn flood_within(
    m: &TriMesh,
    edges: &EdgeMap,
    seed: usize,
    w: V3,
    on_plane: V3,
    cos_tol: f64,
    plane_tol: f64,
) -> Vec<bool> {
    let mut in_region = vec![false; m.triangles.len()];
    in_region[seed] = true;
    let mut stack = vec![seed];
    while let Some(t) = stack.pop() {
        let tri = m.triangles[t];
        for k in 0..3 {
            let Some(&n) = edges.get(&(tri[(k + 1) % 3], tri[k])) else {
                continue;
            };
            let ni = n as usize;
            if in_region[ni] {
                continue;
            }
            let nt = m.triangles[ni];
            let [a, b, c] = m.corners(nt);
            let flat = nt
                .iter()
                .all(|&i| vec3::dot(w, vec3::sub(m.positions[i as usize], on_plane)).abs() <= plane_tol);
            let aligned =
                vec3::normalize(vec3::tri_normal(a, b, c)).is_some_and(|nn| vec3::dot(nn, w) >= cos_tol);
            if flat && aligned {
                in_region[ni] = true;
                stack.push(ni);
            }
        }
    }
    in_region
}

fn face_frame(origin: V3, w: V3, up: Option<V3>) -> Frame {
    let project = |d: V3| vec3::normalize(vec3::sub(d, vec3::scale(w, vec3::dot(d, w))));
    let v = up
        .and_then(project)
        .filter(|v| vec3::len(*v) > 0.5)
        .or_else(|| project([0.0, 0.0, 1.0]).filter(|_| w[2].abs() < 0.99))
        .or_else(|| project([0.0, 1.0, 0.0]))
        .unwrap_or_else(|| vec3::any_perpendicular(w));
    let u = vec3::cross(v, w);
    Frame { origin, u, v, w }
}

struct Loop {
    ids: Vec<u32>,
    pts: Vec<V2>,
}

struct RegionPoly {
    outer: Loop,
    holes: Vec<Loop>,
}

impl RegionPoly {
    fn polygon(&self) -> (Polygon, Vec<u32>) {
        let poly = Polygon {
            outer: self.outer.pts.clone(),
            holes: self.holes.iter().map(|l| l.pts.clone()).collect(),
        };
        let mut ids = self.outer.ids.clone();
        for l in &self.holes {
            ids.extend_from_slice(&l.ids);
        }
        (poly, ids)
    }
}

fn region_polygons(
    m: &TriMesh,
    edges: &EdgeMap,
    in_region: &[bool],
    frame: &Frame,
) -> Result<Vec<RegionPoly>> {
    let mut bnd: Vec<(u32, u32)> = Vec::new();
    for (tri, _) in m.triangles.iter().zip(in_region).filter(|(_, r)| **r) {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if edges.get(&(b, a)).is_none_or(|&n| !in_region[n as usize]) {
                bnd.push((a, b));
            }
        }
    }
    let pos = |i: u32| frame.project(m.positions[i as usize]);
    let mut from: HashMap<u32, Vec<usize>, BuildHasherDefault<KeyHasher>> = HashMap::default();
    for (i, &(a, _)) in bnd.iter().enumerate() {
        from.entry(a).or_default().push(i);
    }
    let mut used = vec![false; bnd.len()];
    let mut loops: Vec<Loop> = Vec::new();
    for e0 in 0..bnd.len() {
        if used[e0] {
            continue;
        }
        used[e0] = true;
        let start = bnd[e0].0;
        let mut ids = vec![start];
        let mut cur = bnd[e0];
        while cur.1 != start {
            ids.push(cur.1);
            let cands: Vec<usize> = from
                .get(&cur.1)
                .map(|v| v.iter().copied().filter(|&e| !used[e]).collect())
                .unwrap_or_default();
            let next = if let [only] = cands.as_slice() {
                Some(*only)
            } else {
                let (v, back) = (pos(cur.1), pos(cur.0));
                let bd = [back[0] - v[0], back[1] - v[1]];
                cands.iter().copied().min_by(|&x, &y| {
                    let cw = |e: usize| {
                        let o = pos(bnd[e].1);
                        let od = [o[0] - v[0], o[1] - v[1]];
                        let ang = -(bd[0] * od[1] - bd[1] * od[0]).m_atan2(bd[0] * od[0] + bd[1] * od[1]);
                        if ang <= 0.0 {
                            ang + std::f64::consts::TAU
                        } else {
                            ang
                        }
                    };
                    cw(x).total_cmp(&cw(y))
                })
            };
            let Some(e) = next else {
                return Err(Error::geometry("emboss", "the face boundary is not closed"));
            };
            used[e] = true;
            cur = bnd[e];
        }
        if ids.len() >= 3 {
            let pts = ids.iter().map(|&i| pos(i)).collect();
            loops.push(Loop { ids, pts });
        }
    }
    let mut outers: Vec<RegionPoly> = Vec::new();
    let mut holes: Vec<Loop> = Vec::new();
    for l in loops {
        if poly2d::signed_area(&l.pts) > 0.0 {
            outers.push(RegionPoly {
                outer: l,
                holes: Vec::new(),
            });
        } else {
            holes.push(l);
        }
    }
    if outers.is_empty() {
        return Err(Error::geometry("emboss", "the face has no outer boundary"));
    }
    for h in holes {
        let probe = poly2d::interior_point(&h.pts);
        let owner = (0..outers.len())
            .filter(|&i| poly2d::point_in_ring(probe, &outers[i].outer.pts))
            .min_by(|&x, &y| {
                poly2d::signed_area(&outers[x].outer.pts)
                    .total_cmp(&poly2d::signed_area(&outers[y].outer.pts))
            });
        if let Some(i) = owner {
            outers[i].holes.push(h);
        }
    }
    Ok(outers)
}

fn seg_dist(a: V2, b: V2, c: V2, d: V2) -> f64 {
    let cross = |p: V2, q: V2, r: V2| poly2d::orient(p, q, r);
    let (o1, o2, o3, o4) = (cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b));
    if o1 * o2 < 0.0 && o3 * o4 < 0.0 {
        return 0.0;
    }
    let pt = |p: V2, s: V2, e: V2| {
        let (dx, dy) = (e[0] - s[0], e[1] - s[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 {
            (((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (p[0] - s[0] - t * dx).m_hypot(p[1] - s[1] - t * dy)
    };
    pt(a, c, d).min(pt(b, c, d)).min(pt(c, a, b)).min(pt(d, a, b))
}

fn select_region(
    base: &TriMesh,
    edges: &EdgeMap,
    in_region: &[bool],
    frame: &Frame,
    polys: &[Polygon],
    full: Vec<RegionPoly>,
) -> Result<(Vec<RegionPoly>, Vec<usize>, Vec<bool>)> {
    let (lo, hi) = text_bounds(polys);
    let near: Vec<bool> = base
        .triangles
        .iter()
        .zip(in_region)
        .map(|(t, &r)| {
            r && {
                let (tl, th) = tri_bounds(base, frame, *t);
                (0..2).all(|k| th[k] >= lo[k] - 2.0 * MARGIN_MM && tl[k] <= hi[k] + 2.0 * MARGIN_MM)
            }
        })
        .collect();
    let local = region_polygons(base, edges, &near, frame)?;
    if let Some(owner) = polys
        .iter()
        .map(|p| locate(&local, p.outer[0]))
        .collect::<Option<Vec<usize>>>()
    {
        return Ok((local, owner, near));
    }
    let owner = polys
        .iter()
        .map(|p| locate(&full, p.outer[0]))
        .collect::<Option<Vec<usize>>>()
        .ok_or_else(|| Error::geometry("emboss", "text does not fit on the face"))?;
    Ok((full, owner, in_region.to_vec()))
}

fn text_bounds(polys: &[Polygon]) -> (V2, V2) {
    polys.iter().flat_map(|p| p.outer.iter()).fold(
        ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]),
        |(lo, hi), p| {
            (
                [lo[0].min(p[0]), lo[1].min(p[1])],
                [hi[0].max(p[0]), hi[1].max(p[1])],
            )
        },
    )
}

fn tri_bounds(m: &TriMesh, frame: &Frame, t: [u32; 3]) -> (V2, V2) {
    t.iter().map(|&i| frame.project(m.positions[i as usize])).fold(
        ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]),
        |(lo, hi), p| {
            (
                [lo[0].min(p[0]), lo[1].min(p[1])],
                [hi[0].max(p[0]), hi[1].max(p[1])],
            )
        },
    )
}

fn locate(region: &[RegionPoly], p: V2) -> Option<usize> {
    region.iter().position(|r| {
        poly2d::point_in_ring(p, &r.outer.pts) && !r.holes.iter().any(|h| poly2d::point_in_ring(p, &h.pts))
    })
}

fn check_fit(region: &[RegionPoly], polys: &[Polygon]) -> Result<()> {
    let (lo, hi) = text_bounds(polys);
    let mut near: Vec<(V2, V2)> = Vec::new();
    for l in region
        .iter()
        .flat_map(|r| std::iter::once(&r.outer).chain(&r.holes))
    {
        let n = l.pts.len();
        for i in 0..n {
            let (p, q) = (l.pts[i], l.pts[(i + 1) % n]);
            let inside =
                (0..2).all(|k| p[k].max(q[k]) >= lo[k] - MARGIN_MM && p[k].min(q[k]) <= hi[k] + MARGIN_MM);
            if inside {
                near.push((p, q));
            }
        }
    }
    let fail = || Error::geometry("emboss", "text does not fit on the face");
    if !near.is_empty() {
        for p in polys {
            let n = p.outer.len();
            for i in 0..n {
                let (a, b) = (p.outer[i], p.outer[(i + 1) % n]);
                if near.iter().any(|&(c, d)| seg_dist(a, b, c, d) < MARGIN_MM) {
                    return Err(fail());
                }
            }
        }
    }
    if polys.iter().all(|p| locate(region, p.outer[0]).is_some()) {
        Ok(())
    } else {
        Err(fail())
    }
}

fn ray_tri(o: V3, dir: V3, a: V3, b: V3, c: V3) -> Option<f64> {
    use vec3::{cross, dot, sub};
    let (e1, e2) = (sub(b, a), sub(c, a));
    let p = cross(dir, e2);
    let det = dot(e1, p);
    if det.abs() < 1e-14 {
        return None;
    }
    let inv = 1.0 / det;
    let s = sub(o, a);
    let u = dot(s, p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(s, e1);
    let v = dot(dir, q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    Some(dot(e2, q) * inv)
}

fn check_thickness(
    m: &TriMesh,
    in_region: &[bool],
    frame: &Frame,
    polys: &[Polygon],
    depth: f64,
) -> Result<()> {
    let mut samples: Vec<V2> = Vec::new();
    for p in polys {
        let step = (p.outer.len() / 8).max(1);
        samples.extend(p.outer.iter().step_by(step));
        let ip = poly2d::interior_point(&p.outer);
        if p.contains(ip) {
            samples.push(ip);
        }
    }
    let dir = vec3::scale(frame.w, -1.0);
    let (lo, hi) = text_bounds(polys);
    let below: Vec<[u32; 3]> = m
        .triangles
        .iter()
        .zip(in_region)
        .filter(|(t, r)| {
            !**r && t
                .iter()
                .any(|&i| frame.height(m.positions[i as usize]) < PLANE_TOL_MM)
                && {
                    let (tl, th) = tri_bounds(m, frame, **t);
                    (0..2).all(|k| th[k] >= lo[k] && tl[k] <= hi[k])
                }
        })
        .map(|(t, _)| *t)
        .collect();
    let mut thin = f64::INFINITY;
    for s in samples {
        let o = frame.at(s, 0.0);
        for tri in &below {
            let [a, b, c] = m.corners(*tri);
            if let Some(d) = ray_tri(o, dir, a, b, c).filter(|d| *d > 1e-4) {
                thin = thin.min(d);
            }
        }
    }
    if thin < depth + MIN_FLOOR_MM {
        return Err(Error::geometry(
            "emboss",
            format!(
                "deboss depth {depth:.2} mm is too deep: the part is {thin:.2} mm thick under the text and {MIN_FLOOR_MM} mm must remain"
            ),
        ));
    }
    Ok(())
}

fn push_tris(out: &mut TriMesh, poly: &Polygon, ids: &[u32]) -> Result<()> {
    for t in poly2d::triangulate(poly)? {
        out.triangles
            .push([ids[t[0] as usize], ids[t[1] as usize], ids[t[2] as usize]]);
    }
    Ok(())
}

struct TextRing {
    l0: Vec<u32>,
    lh: Vec<u32>,
}

impl TextRing {
    fn new(out: &mut TriMesh, frame: &Frame, ring: &[V2], h: f64, raised: bool) -> Self {
        let l0 = ring.iter().map(|&p| out.push_vertex(frame.at(p, 0.0))).collect();
        let lh = if raised {
            ring.iter().map(|&p| out.push_vertex(frame.at(p, h))).collect()
        } else {
            Vec::new()
        };
        Self { l0, lh }
    }

    fn push_walls(&self, out: &mut TriMesh) {
        let n = self.l0.len();
        for i in 0..n {
            let j = (i + 1) % n;
            out.triangles.push([self.l0[i], self.l0[j], self.lh[j]]);
            out.triangles.push([self.l0[i], self.lh[j], self.lh[i]]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{self, box_mesh};
    use crate::poly2d;
    use crate::vec3::Frame;

    fn spec(text: &str, point: V3, size: f64, depth: f64, mode: EmbossMode) -> EmbossSpec {
        EmbossSpec {
            text: text.into(),
            point,
            normal: None,
            up: None,
            size_mm: size,
            stroke_mm: None,
            depth_mm: depth,
            mode,
        }
    }

    fn slab() -> TriMesh {
        box_mesh([0.0, 0.0, 0.0], [60.0, 20.0, 10.0])
    }

    fn text_area(text: &str, size: f64) -> f64 {
        font::text_polygons(text, size, size * 0.16)
            .iter()
            .map(Polygon::area)
            .sum()
    }

    #[test]
    fn deboss_on_top_removes_text_volume() {
        let m = slab();
        let s = spec("SX 42", [30.0, 10.0, 10.0], 6.0, 1.0, EmbossMode::Deboss);
        let r = emboss_text(&m, &s).unwrap();
        assert!(r.edge_report().is_watertight(), "{:?}", r.edge_report());
        let drop = m.volume() - r.volume();
        let want = text_area("SX 42", 6.0);
        assert!((drop - want).abs() / want < 1e-6, "{drop} vs {want}");
    }

    #[test]
    fn calibration_labels_deboss_watertight() {
        let m = box_mesh([0.0; 3], [40.0, 40.0, 10.0]);
        for (text, size) in [
            ("0.3", 5.0),
            ("0.5", 5.0),
            ("2-1", 5.0),
            ("0.3", 4.0),
            ("2-1", 3.0),
            ("1.25", 6.0),
        ] {
            for mode in [EmbossMode::Deboss, EmbossMode::Emboss] {
                let s = spec(text, [20.0, 20.0, 10.0], size, 0.6, mode);
                let r = emboss_text(&m, &s).unwrap();
                assert!(
                    r.edge_report().is_watertight(),
                    "{text} {size} {mode:?} {:?}",
                    r.edge_report()
                );
            }
        }
    }

    #[test]
    fn merge_coplanar_collapses_sliver_fans() {
        use crate::convex::{ConvexSolid, subtract};
        let cube = box_mesh([0.0; 3], [20.0, 20.0, 10.0]);
        let hole = ConvexSolid::cylinder(
            &Frame {
                origin: [10.0, 10.0, -1.0],
                ..Frame::WORLD
            },
            1.7,
            0.0,
            12.0,
            48,
        )
        .unwrap();
        let drilled = subtract(&cube, &hole).unwrap();
        let merged = merge_coplanar(&drilled).unwrap();
        assert!(merged.edge_report().is_watertight());
        assert!(
            merged.triangles.len() * 3 < drilled.triangles.len(),
            "{} vs {}",
            merged.triangles.len(),
            drilled.triangles.len()
        );
        assert!((merged.volume() - drilled.volume()).abs() < 1e-6);
        assert_eq!(merged.bounds(), drilled.bounds());
        let sphere = build::uv_sphere([0.0; 3], 10.0, 20, 30);
        assert_eq!(
            merge_coplanar(&sphere).unwrap().triangles.len(),
            sphere.triangles.len()
        );
    }

    #[test]
    fn attached_solids_make_one_shell() {
        let slab = slab();
        let post = build::cylinder(
            &Frame {
                origin: [15.0, 10.0, 10.0],
                ..Frame::WORLD
            },
            4.0,
            0.0,
            12.0,
            48,
        );
        let ring = poly2d::rect([0.0, 0.0], [6.0, 3.0]);
        let mut rib = build::extrude(
            &[Polygon::simple(ring)],
            &Frame {
                origin: [40.0, 8.0, 10.0],
                ..Frame::WORLD
            },
            0.0,
            5.0,
        )
        .unwrap();
        rib.append(&post);
        let one = attach_solid(&slab, &post, [15.0, 10.0, 10.0], Some([0.0, 0.0, 1.0])).unwrap();
        assert!(one.edge_report().is_watertight(), "{:?}", one.edge_report());
        assert_eq!(one.components().len(), 1);
        assert!((one.volume() - slab.volume() - post.volume()).abs() < 1e-6);
        let two = attach_solid(&slab, &rib, [15.0, 10.0, 10.0], Some([0.0, 0.0, 1.0])).unwrap();
        assert!(two.edge_report().is_watertight(), "{:?}", two.edge_report());
        assert_eq!(two.components().len(), 1);
        assert!((two.volume() - slab.volume() - rib.volume()).abs() < 1e-6);
        let floating = build::box_mesh([5.0, 5.0, 12.0], [8.0, 8.0, 15.0]);
        assert!(attach_solid(&slab, &floating, [6.0, 6.0, 10.0], Some([0.0, 0.0, 1.0])).is_err());
    }

    #[test]
    fn emboss_on_side_face_adds_volume() {
        let m = slab();
        let mut s = spec("AB", [30.0, 0.0, 5.0], 4.0, 0.8, EmbossMode::Emboss);
        s.normal = Some([0.0, -1.0, 0.0]);
        let r = emboss_text(&m, &s).unwrap();
        assert!(r.edge_report().is_watertight());
        let gain = r.volume() - m.volume();
        let want = text_area("AB", 4.0) * 0.8;
        assert!((gain - want).abs() / want < 1e-6, "{gain} vs {want}");
        let b = r.bounds().unwrap();
        assert!((b.min[1] + 0.8).abs() < 1e-9);
    }

    #[test]
    fn letters_with_holes_work() {
        for (text, mode) in [
            ("O", EmbossMode::Deboss),
            ("A", EmbossMode::Emboss),
            ("B", EmbossMode::Deboss),
            ("8", EmbossMode::Emboss),
            ("OAB8", EmbossMode::Deboss),
        ] {
            let m = slab();
            let r = emboss_text(&m, &spec(text, [30.0, 10.0, 10.0], 8.0, 1.0, mode)).unwrap();
            assert!(r.edge_report().is_watertight(), "{text}");
            let delta = (r.volume() - m.volume()).abs();
            let want = text_area(text, 8.0);
            assert!((delta - want).abs() / want < 1e-6, "{text}: {delta} vs {want}");
        }
    }

    #[test]
    fn oversize_text_fails_to_fit() {
        let m = slab();
        let err = emboss_text(
            &m,
            &spec(
                "SX 42 SX 42 SX 42",
                [30.0, 10.0, 10.0],
                8.0,
                1.0,
                EmbossMode::Deboss,
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("does not fit"), "{err}");
        let err = emboss_text(&m, &spec("X", [58.0, 10.0, 10.0], 8.0, 1.0, EmbossMode::Emboss)).unwrap_err();
        assert!(err.to_string().contains("does not fit"), "{err}");
    }

    #[test]
    fn deboss_through_a_thin_part_fails() {
        let m = box_mesh([0.0, 0.0, 0.0], [60.0, 20.0, 1.0]);
        let err = emboss_text(&m, &spec("A", [30.0, 10.0, 1.0], 6.0, 0.9, EmbossMode::Deboss)).unwrap_err();
        assert!(err.to_string().contains("too deep"), "{err}");
        assert!(emboss_text(&m, &spec("A", [30.0, 10.0, 1.0], 6.0, 0.5, EmbossMode::Deboss)).is_ok());
    }

    #[test]
    fn second_deboss_beside_the_first() {
        let m = slab();
        let first = emboss_text(&m, &spec("OK", [16.0, 10.0, 10.0], 8.0, 1.0, EmbossMode::Deboss)).unwrap();
        let second = emboss_text(
            &first,
            &spec("B8", [44.0, 10.0, 10.0], 8.0, 1.0, EmbossMode::Deboss),
        )
        .unwrap();
        assert!(second.edge_report().is_watertight());
        let want = text_area("OK", 8.0) + text_area("B8", 8.0);
        let drop = m.volume() - second.volume();
        assert!((drop - want).abs() / want < 1e-6, "{drop} vs {want}");
        let err = emboss_text(
            &first,
            &spec("OK", [16.0, 10.0, 10.0], 8.0, 1.0, EmbossMode::Deboss),
        )
        .unwrap_err();
        assert!(err.to_string().contains("does not fit"), "{err}");
    }

    #[test]
    fn star_logo_embosses() {
        let ring: Vec<V2> = (0..10)
            .map(|i| {
                let a = std::f64::consts::TAU * f64::from(i) / 10.0 + std::f64::consts::FRAC_PI_2;
                let r = if i % 2 == 0 { 6.0 } else { 2.5 };
                [r * a.m_cos(), r * a.m_sin()]
            })
            .collect();
        let star = Polygon::simple(ring);
        let m = slab();
        let r = emboss_polygons(
            &m,
            std::slice::from_ref(&star),
            [30.0, 10.0, 10.0],
            None,
            None,
            0.6,
            EmbossMode::Emboss,
        )
        .unwrap();
        assert!(r.edge_report().is_watertight());
        assert!((r.volume() - m.volume() - star.area() * 0.6).abs() < 1e-6);
    }

    #[test]
    fn up_direction_rotates_the_text() {
        let m = slab();
        let mut s = spec("I", [30.0, 10.0, 10.0], 8.0, 1.0, EmbossMode::Emboss);
        s.up = Some([1.0, 0.0, 0.0]);
        let r = emboss_text(&m, &s).unwrap();
        let b = r.bounds().unwrap();
        let top: Vec<V3> = r.positions.iter().copied().filter(|p| p[2] > 10.5).collect();
        let (mut min_x, mut max_x) = (f64::MAX, f64::MIN);
        for p in &top {
            min_x = min_x.min(p[0]);
            max_x = max_x.max(p[0]);
        }
        assert!(max_x - min_x > 7.0 && b.max[2] > 10.9);
    }

    #[test]
    fn json_shape_round_trips() {
        let j = r#"{"text":"HI","point":[1,2,3],"sizeMm":5,"depthMm":1,"mode":"deboss"}"#;
        let s: EmbossSpec = serde_json::from_str(j).unwrap();
        assert_eq!(s.mode, EmbossMode::Deboss);
        assert!(s.normal.is_none() && s.stroke_mm.is_none());
        assert!(serde_json::to_string(&s).unwrap().contains("\"sizeMm\":5"));
    }

    #[test]
    #[ignore = "timing, run with --release -- --ignored --nocapture"]
    fn timing_budget() {
        use std::time::Instant;
        let label = "SLICERX 0123456789";
        let m = slab();
        let s = spec(label, [30.0, 10.0, 10.0], 3.0, 0.6, EmbossMode::Deboss);
        let t = Instant::now();
        let r = emboss_text(&m, &s).unwrap();
        println!("box label: {:?} ({} tris)", t.elapsed(), r.triangles.len());

        let disc = Polygon::simple(poly2d::circle([0.0, 0.0], 40.0, 7_500));
        let big = build::extrude(&[disc], &Frame::WORLD, 0.0, 5.0).unwrap();
        assert!(big.triangles.len() > 29_000);
        let s = spec(label, [0.0, 0.0, 5.0], 4.0, 0.6, EmbossMode::Deboss);
        let t = Instant::now();
        let r = emboss_text(&big, &s).unwrap();
        println!("30k mesh label: {:?} ({} tris)", t.elapsed(), r.triangles.len());
        assert!(r.edge_report().is_watertight());
    }
}
