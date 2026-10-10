// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! flat faces triangulated again with well shaped triangles
//!
//! caps, fillet ends and boolean footprints come out as fans from a few corners, full of slivers. this finds
//! each flat face (connected coplanar triangles of one face id), splits its long outline edges, and fills it with
//! a constrained delaunay triangulation refined to a 20 degree smallest angle where the outline allows. only edges
//! between two flat faces are split, so the facets of a round stay as they are, and the mesh stays watertight.
//! the surface does not move: every new vertex lies on an old edge or inside an old flat face.
//!
//! `coarsen_flat` goes the other way, for an edge round's input: flat faces from their corners alone.
// indices come from the mesh's own triangles, checked when it entered the crate
#![allow(clippy::indexing_slicing)]

use crate::faces::Faces;
use crate::fm::Fm as _;
use crate::mesh::TriMesh;
use crate::vec3::{self, V3};
use rustc_hash::{FxBuildHasher, FxHashMap};
use spade::{AngleLimit, ConstrainedDelaunayTriangulation, Point2, RefinementParameters, Triangulation};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy)]
pub struct RemeshOptions {
    /// the smallest angle refinement aims for, degrees
    pub min_angle_deg: f64,
    /// new vertices allowed, as a multiple of the vertices the mesh had (plus a fixed allowance)
    pub max_growth: f64,
}

impl Default for RemeshOptions {
    fn default() -> Self {
        Self {
            min_angle_deg: 20.0,
            max_growth: 4.0,
        }
    }
}

type Edge = (u32, u32);

fn key(a: u32, b: u32) -> Edge {
    if a < b { (a, b) } else { (b, a) }
}

/// the smallest angle of a triangle, degrees (0 for a degenerate one)
pub fn min_angle(a: V3, b: V3, c: V3) -> f64 {
    let mut best = 180.0f64;
    for (p, q, r) in [(a, b, c), (b, c, a), (c, a, b)] {
        let u = vec3::sub(q, p);
        let w = vec3::sub(r, p);
        let (lu, lw) = (vec3::len(u), vec3::len(w));
        if lu * lw <= 0.0 {
            return 0.0;
        }
        let cos = (vec3::dot(u, w) / (lu * lw)).clamp(-1.0, 1.0);
        best = best.min(cos.m_acos().to_degrees());
    }
    best
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// a flat face to fill again
    Face,
    /// a facet of a round, or a sliver along one: left as it is
    Strip,
}

struct Region {
    tris: Vec<usize>,
    normal: V3,
    kind: Kind,
    /// the target edge length on its outline
    h: f64,
    bad: bool,
    /// an outline edge that cannot be split (it borders a round) is too long for good triangles to reach across:
    /// splitting its other edges would only fan them out
    limited: bool,
}

/// the mesh with its flat faces filled again; the mesh itself when nothing needs it
pub fn remesh_flat(mesh: &TriMesh, opts: &RemeshOptions) -> TriMesh {
    remesh_inner(mesh, opts).unwrap_or_else(|| mesh.clone())
}

#[allow(clippy::too_many_lines, reason = "one pass, read top to bottom")]
fn remesh_inner(original: &TriMesh, opts: &RemeshOptions) -> Option<TriMesh> {
    // vertices a hair apart (booleans leave some) would make triangles that collapse once stored as f32: welded at
    // about f32's own precision
    let f32_tol = original
        .bounds()
        .map_or(1e-6, |b| (b.diagonal() * 1e-7).max(1e-9));
    let mut welded = original.weld(f32_tol);
    let needles = drop_needles(&mut welded);
    let mesh = &welded;
    let n = mesh.triangles.len();
    if n == 0 {
        return None;
    }
    let pos = &mesh.positions;
    let tri_pts = |t: usize| mesh.triangles[t].map(|i| pos[i as usize]);
    let ids = mesh.faces.as_ref().filter(|f| f.ids.len() == n).map(|f| &f.ids);
    let bounds = mesh.bounds()?;
    let diag = bounds.diagonal();
    // meshes come in as f32: planes and lines are the same within its precision
    let dist_tol = (diag * 1e-7).max(1e-9);

    let Flat {
        edges,
        normals,
        region_of,
        mut regions,
    } = flat_regions(mesh, None, dist_tol)?;

    // outline edges of each region, and what it is
    let outline = |r: &Region| -> Vec<(u32, u32)> {
        let mut out = Vec::new();
        for &t in &r.tris {
            let tri = mesh.triangles[t];
            for k in 0..3 {
                let (a, b) = (tri[k], tri[(k + 1) % 3]);
                if edges[&key(a, b)].iter().any(|&o| region_of[o] != region_of[t]) {
                    out.push((a, b));
                }
            }
        }
        out
    };
    let target = opts.min_angle_deg;
    let mut any_bad = false;
    for r in &mut regions {
        if r.kind != Kind::Face {
            continue;
        }
        let mut area = 0.0;
        for &t in &r.tris {
            let [a, b, c] = tri_pts(t);
            area += vec3::len(vec3::cross(vec3::sub(b, a), vec3::sub(c, a))) / 2.0;
        }
        let rim: f64 = {
            let mut s = 0.0;
            for &t in &r.tris {
                let tri = mesh.triangles[t];
                for k in 0..3 {
                    let (a, b) = (tri[k], tri[(k + 1) % 3]);
                    if edges[&key(a, b)].iter().any(|&o| region_of[o] != region_of[t]) {
                        s += vec3::len(vec3::sub(pos[b as usize], pos[a as usize]));
                    }
                }
            }
            s
        };
        let width = if rim > 0.0 { 2.0 * area / rim } else { 0.0 };
        let longest = r
            .tris
            .iter()
            .flat_map(|&t| {
                let [a, b, c] = tri_pts(t);
                [
                    vec3::len(vec3::sub(b, a)),
                    vec3::len(vec3::sub(c, b)),
                    vec3::len(vec3::sub(a, c)),
                ]
            })
            .fold(0.0, f64::max);
        // a two triangle face far longer than wide that folds gently into its neighbours along its long sides
        // is a facet strip of a round
        if r.tris.len() <= 2 && width < 0.1 * longest {
            let gentle = r.tris.iter().all(|&t| {
                let tri = mesh.triangles[t];
                (0..3).all(|k| {
                    let (a, b) = (tri[k], tri[(k + 1) % 3]);
                    if vec3::len(vec3::sub(pos[b as usize], pos[a as usize])) < 0.5 * longest {
                        return true;
                    }
                    edges[&key(a, b)].iter().filter(|&&o| o != t).all(|&o| {
                        region_of[o] == region_of[t]
                            || normals[o].is_some_and(|no| vec3::dot(no, r.normal) > 0.866)
                    })
                })
            });
            if gentle {
                r.kind = Kind::Strip;
                continue;
            }
        }
        // too thin to fill with good triangles: a sliver face along a round, left as it is
        if width < diag * 2e-3 {
            r.kind = Kind::Strip;
            continue;
        }
        r.h = width;
        r.bad = r.tris.iter().any(|&t| {
            let [a, b, c] = tri_pts(t);
            min_angle(a, b, c) < target - 1e-9
        });
        any_bad |= r.bad;
    }
    // a 20 degree triangle on an edge of length l needs its corner about l / 5.5 away, inside the face
    let kinds: Vec<Kind> = regions.iter().map(|r| r.kind).collect();
    for (ri, r) in regions.iter_mut().enumerate() {
        if r.kind != Kind::Face {
            continue;
        }
        r.limited = r.tris.iter().any(|&t| {
            let tri = mesh.triangles[t];
            (0..3).any(|k| {
                let (a, b) = (tri[k], tri[(k + 1) % 3]);
                let across = edges[&key(a, b)]
                    .iter()
                    .any(|&o| region_of[o] != ri && kinds[region_of[o]] != Kind::Face);
                across && vec3::len(vec3::sub(pos[b as usize], pos[a as usize])) > 5.5 * r.h
            })
        });
    }
    if !any_bad && needles == 0 {
        return None;
    }
    let budget = count(pos.len() as f64 * opts.max_growth) + 10_000;

    // split points per edge, as parameters from the lower vertex index to the higher: each edge between two flat
    // faces next to a bad one, evenly at the finer face's spacing (a point on a round's facet would run down every
    // facet of it, so those edges stay)
    let mut splits: FxHashMap<Edge, Vec<f64>> = FxHashMap::default();
    let mut added = 0usize;
    for (&e, tris) in &edges {
        let (ra, rb) = (&regions[region_of[tris[0]]], &regions[region_of[tris[1]]]);
        if region_of[tris[0]] == region_of[tris[1]]
            || ra.kind != Kind::Face
            || rb.kind != Kind::Face
            || !(ra.bad || rb.bad)
            || ra.limited
            || rb.limited
        {
            continue;
        }
        let l = vec3::len(vec3::sub(pos[e.1 as usize], pos[e.0 as usize]));
        let k = count((l / ra.h.min(rb.h)).round());
        if k < 2 {
            continue;
        }
        splits.insert(e, (1..k).map(|i| i as f64 / k as f64).collect());
        added += k - 1;
    }
    if added > budget {
        return None;
    }

    // the new vertices on split edges
    let mut positions = pos.clone();
    let mut on_edge: FxHashMap<Edge, Vec<u32>> = FxHashMap::default();
    for (e, ts) in &splits {
        if ts.is_empty() {
            continue;
        }
        let (pa, pb) = (pos[e.0 as usize], pos[e.1 as usize]);
        let mut v = Vec::with_capacity(ts.len());
        for &t in ts {
            v.push(u32::try_from(positions.len()).ok()?);
            positions.push(vec3::lerp(pa, pb, t));
        }
        on_edge.insert(*e, v);
    }
    // the points along a directed edge, ends excluded
    let chain = |a: u32, b: u32| -> Vec<u32> {
        match on_edge.get(&key(a, b)) {
            Some(v) if a < b => v.clone(),
            Some(v) => v.iter().rev().copied().collect(),
            None => Vec::new(),
        }
    };

    // regions filled again, by the first triangle they had
    let id_of = |t: usize| ids.map_or(0, |ids| ids[t]);
    let mut filled_at: FxHashMap<usize, (Vec<[u32; 3]>, Vec<u32>)> = FxHashMap::default();
    let mut done = vec![false; n];
    for r in &regions {
        let touched = r.tris.iter().any(|&t| {
            let tri = mesh.triangles[t];
            (0..3).any(|k| on_edge.contains_key(&key(tri[k], tri[(k + 1) % 3])))
        });
        let face = r.kind == Kind::Face;
        if !((face && r.bad) || touched) || (!face && r.tris.len() == 1 && normals[r.tris[0]].is_none()) {
            continue;
        }
        let loops = outline(r)
            .into_iter()
            .flat_map(|(a, b)| {
                let mut seg = vec![a];
                seg.extend(chain(a, b));
                seg.push(b);
                seg.windows(2).map(|w| (w[0], w[1])).collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        // the worst smallest angle, and the share of triangles under the target
        let score = |tris: &mut dyn Iterator<Item = [V3; 3]>| {
            let (mut worst, mut under, mut n) = (180.0f64, 0usize, 0usize);
            for [a, b, c] in tris {
                let m = min_angle(a, b, c);
                worst = worst.min(m);
                under += usize::from(m < target);
                n += 1;
            }
            (worst, under as f64 / n.max(1) as f64)
        };
        let before = score(&mut r.tris.iter().map(|&t| tri_pts(t)));
        if let Some(filled) = fill(&mut positions, &loops, r.normal, face, target, budget) {
            // a face no edge of which was split takes the new triangles only when fewer are poor and none is a
            // needle it did not have
            let after = score(&mut filled.iter().map(|t| t.map(|i| positions[i as usize])));
            let better = after.1 < before.1 && after.0 >= before.0.min(2.0) - 1e-9;
            if !touched && !better {
                continue;
            }
            for &t in &r.tris {
                done[t] = true;
            }
            let fid = ids_for(mesh, &positions, &r.tris, &filled, ids);
            filled_at.insert(r.tris.iter().copied().min().unwrap_or(0), (filled, fid));
        }
    }
    // in the order the triangles came, a filled region where its first triangle was; the rest as they were, or
    // each triangle filled again with the points on its edges
    let mut triangles: Vec<[u32; 3]> = Vec::with_capacity(n);
    let mut out_ids: Vec<u32> = Vec::with_capacity(n);
    #[allow(clippy::needless_range_loop, reason = "t indexes several tables")]
    for t in 0..n {
        if let Some((filled, fid)) = filled_at.remove(&t) {
            out_ids.extend(fid);
            triangles.extend(filled);
            continue;
        }
        if done[t] {
            continue;
        }
        let tri = mesh.triangles[t];
        if !(0..3).any(|k| on_edge.contains_key(&key(tri[k], tri[(k + 1) % 3]))) {
            triangles.push(tri);
            out_ids.push(id_of(t));
            continue;
        }
        let mut segs = Vec::new();
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            let mut seg = vec![a];
            seg.extend(chain(a, b));
            seg.push(b);
            segs.extend(seg.windows(2).map(|w| (w[0], w[1])));
        }
        let nrm = normals[t]?;
        for f in fill(&mut positions, &segs, nrm, false, 0.0, 0)? {
            triangles.push(f);
            out_ids.push(id_of(t));
        }
    }

    let mut out = TriMesh::new(positions, triangles);
    if let Some(f) = &mesh.faces {
        out.faces = Some(Faces {
            ids: out_ids,
            table: f.table.clone(),
            keys: f.keys.clone(),
        });
    }
    let out = compact(out);
    // the same surface, closed as before
    let before = original.edge_report();
    let after = out.edge_report();
    if after.is_watertight() != before.is_watertight()
        || (out.volume() - original.volume()).abs() > 1e-6 * original.volume().abs().max(1.0)
    {
        return None;
    }
    Some(out)
}

struct Flat {
    edges: FxHashMap<Edge, Vec<usize>>,
    normals: Vec<Option<V3>>,
    region_of: Vec<usize>,
    regions: Vec<Region>,
}

/// edges with their triangles, and the flat regions: neighbours with the same plane (and face id, when given). None
/// for an open or non-manifold mesh.
fn flat_regions(mesh: &TriMesh, ids: Option<&Vec<u32>>, dist_tol: f64) -> Option<Flat> {
    let n = mesh.triangles.len();
    let pos = &mesh.positions;
    let tri_pts = |t: usize| mesh.triangles[t].map(|i| pos[i as usize]);
    // edges and their triangles
    let mut edges: FxHashMap<Edge, Vec<usize>> = FxHashMap::with_capacity_and_hasher(n * 2, FxBuildHasher);
    for (t, tri) in mesh.triangles.iter().enumerate() {
        for k in 0..3 {
            edges.entry(key(tri[k], tri[(k + 1) % 3])).or_default().push(t);
        }
    }
    if edges.values().any(|v| v.len() != 2) {
        return None; // open or non-manifold: leave it
    }
    let normals: Vec<Option<V3>> = (0..n)
        .map(|t| {
            let [a, b, c] = tri_pts(t);
            vec3::normalize(vec3::cross(vec3::sub(b, a), vec3::sub(c, a)))
        })
        .collect();

    // flat regions: neighbours on the same plane (and of the same face id, when given), grown from the biggest
    // triangles, whose normals are the surest; a sliver joins by where its corners are, its own normal being noise
    let area = |t: usize| {
        let [a, b, c] = tri_pts(t);
        vec3::len(vec3::cross(vec3::sub(b, a), vec3::sub(c, a)))
    };
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&x, &y| area(y).total_cmp(&area(x)).then(x.cmp(&y)));
    let mut region_of = vec![usize::MAX; n];
    let mut regions: Vec<Region> = Vec::new();
    for start in order {
        if region_of[start] != usize::MAX {
            continue;
        }
        let Some(nrm) = normals[start] else {
            region_of[start] = regions.len();
            regions.push(Region {
                tris: vec![start],
                normal: [0.0, 0.0, 1.0],
                kind: Kind::Strip,
                h: 0.0,
                bad: false,
                limited: false,
            });
            continue;
        };
        let d0 = vec3::dot(nrm, pos[mesh.triangles[start][0] as usize]);
        let r = regions.len();
        let mut tris = vec![start];
        region_of[start] = r;
        let mut q = VecDeque::from([start]);
        while let Some(t) = q.pop_front() {
            let tri = mesh.triangles[t];
            for k in 0..3 {
                for &o in &edges[&key(tri[k], tri[(k + 1) % 3])] {
                    if o == t || region_of[o] != usize::MAX {
                        continue;
                    }
                    if ids.is_some_and(|ids| ids[o] != ids[start]) {
                        continue;
                    }
                    if normals[o].is_some_and(|no| vec3::dot(no, nrm) < 0.9) {
                        continue;
                    }
                    if mesh.triangles[o]
                        .iter()
                        .any(|&v| (vec3::dot(nrm, pos[v as usize]) - d0).abs() > dist_tol)
                    {
                        continue;
                    }
                    region_of[o] = r;
                    tris.push(o);
                    q.push_back(o);
                }
            }
        }
        regions.push(Region {
            tris,
            normal: nrm,
            kind: Kind::Face,
            h: 0.0,
            bad: false,
            limited: false,
        });
    }

    Some(Flat {
        edges,
        normals,
        region_of,
        regions,
    })
}

/// the mesh with the extra vertices along the straight edges and inside its flat faces taken out, each flat face
/// filled again from its corners alone: what an edge round wants, since its strips follow every vertex of the edge.
/// The mesh itself when there are none.
pub fn coarsen_flat(mesh: &TriMesh) -> TriMesh {
    coarsen_inner(mesh, false, None).unwrap_or_else(|| mesh.clone())
}

/// `coarsen_flat` for an edge round on `segments` (each edge's ends): only the flat faces that touch them go back to
/// their corners, so faces the round does not reach keep the points an earlier fill gave them.
pub fn coarsen_flat_touching(mesh: &TriMesh, segments: &[(V3, V3)]) -> TriMesh {
    coarsen_inner(mesh, false, Some(segments)).unwrap_or_else(|| mesh.clone())
}

/// the flat faces filled again (`remesh_flat`), or the same from the mesh coarsened first (`coarsen_flat`, a face
/// id's part of a plane counted as a face of its own, so the line between two faces on one plane stays where it was),
/// whichever has fewer poor triangles. A boolean leaves its inputs' corners behind on the result's straight edges: a
/// pushed box keeps its old top's corners and the tool's, 0.01 mm apart, on its side edges, and filling round those
/// gave a plain box 128 triangles, dozens of them slivers. Filling a face again from its corners alone drops the points
/// an earlier fill put inside it, though, which a face next to a round cannot always win back: hence the choice.
pub fn tidy_flat(mesh: &TriMesh, opts: &RemeshOptions) -> TriMesh {
    let plain = remesh_flat(mesh, opts);
    let Some(coarse) = coarsen_inner(mesh, true, None) else {
        return plain;
    };
    let coarse = remesh_flat(&coarse, opts);
    if quality(&coarse, opts.min_angle_deg) < quality(&plain, opts.min_angle_deg) {
        coarse
    } else {
        plain
    }
}

/// triangles under 5 degrees, under `target` degrees, and all triangles: the fewer the better, in that order
fn quality(m: &TriMesh, target: f64) -> (usize, usize, usize) {
    let (mut sliver, mut poor) = (0, 0);
    for t in &m.triangles {
        let [a, b, c] = t.map(|i| m.positions[i as usize]);
        let angle = min_angle(a, b, c);
        sliver += usize::from(angle < 5.0);
        poor += usize::from(angle < target);
    }
    (sliver, poor, m.triangles.len())
}

#[allow(clippy::too_many_lines, reason = "one pass, read top to bottom")]
fn coarsen_inner(original: &TriMesh, by_id: bool, touching: Option<&[(V3, V3)]>) -> Option<TriMesh> {
    let mesh = original;
    let n = mesh.triangles.len();
    let pos = &mesh.positions;
    let diag = mesh.bounds()?.diagonal();
    let ids = mesh.faces.as_ref().filter(|f| f.ids.len() == n).map(|f| &f.ids);
    let Flat {
        edges,
        region_of,
        regions,
        ..
    } = flat_regions(mesh, ids.filter(|_| by_id), (diag * 1e-7).max(1e-9))?;
    // a vertex goes when every triangle round it is on a flat face and it is no corner of any of them
    let mut faces_at: Vec<Vec<usize>> = vec![Vec::new(); pos.len()];
    for (t, tri) in mesh.triangles.iter().enumerate() {
        for &v in tri {
            faces_at[v as usize].push(region_of[t]);
        }
    }
    let rim = |r: usize| -> Vec<(u32, u32)> {
        let mut out = Vec::new();
        for &t in &regions[r].tris {
            let tri = mesh.triangles[t];
            for k in 0..3 {
                let (a, b) = (tri[k], tri[(k + 1) % 3]);
                if edges[&key(a, b)].iter().any(|&o| region_of[o] != r) {
                    out.push((a, b));
                }
            }
        }
        out
    };
    let mut corner = vec![false; pos.len()];
    for (r, reg) in regions.iter().enumerate() {
        if reg.kind != Kind::Face {
            for &t in &reg.tris {
                for &v in &mesh.triangles[t] {
                    corner[v as usize] = true;
                }
            }
            continue;
        }
        let segs = rim(r);
        let mut into: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        let mut out_of: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        for &(a, b) in &segs {
            out_of.entry(a).or_default().push(b);
            into.entry(b).or_default().push(a);
        }
        for (&v, outs) in &out_of {
            let ins = &into[&v];
            if outs.len() != 1 || ins.len() != 1 {
                corner[v as usize] = true;
                continue;
            }
            let (p, q, o) = (pos[ins[0] as usize], pos[outs[0] as usize], pos[v as usize]);
            let d0 = vec3::sub(o, p);
            let d1 = vec3::sub(q, o);
            let straight = vec3::len(vec3::cross(d0, d1)) <= 1e-6 * vec3::len(d0) * vec3::len(d1)
                && vec3::dot(d0, d1) > 0.0;
            if !straight {
                corner[v as usize] = true;
            }
        }
    }
    // Only the faces that touch the given segments (an edge round's edges, by their ends) are coarsened: every
    // vertex of any other face stays, so their earlier fill survives.
    if let Some(segs) = touching {
        let tol = (diag * 1e-6).max(1e-6);
        let near = |p: V3| {
            segs.iter().any(|&(a, b)| {
                let d = vec3::sub(b, a);
                let l2 = vec3::dot(d, d);
                let w = vec3::sub(p, a);
                let t = if l2 > 0.0 {
                    (vec3::dot(w, d) / l2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                vec3::len(vec3::sub(w, vec3::scale(d, t))) <= tol
            })
        };
        for (r, reg) in regions.iter().enumerate() {
            if reg.kind != Kind::Face {
                continue;
            }
            let touched = rim(r).iter().any(|&(a, _)| near(pos[a as usize]));
            if !touched {
                for &t in &reg.tris {
                    for &v in &mesh.triangles[t] {
                        corner[v as usize] = true;
                    }
                }
            }
        }
    }
    let drop = |v: u32| !corner[v as usize];
    if !(0..pos.len()).any(|v| !corner[v] && !faces_at[v].is_empty()) {
        return None;
    }
    let mut positions = pos.clone();
    let mut filled_at: FxHashMap<usize, (Vec<[u32; 3]>, Vec<u32>)> = FxHashMap::default();
    let mut done = vec![false; n];
    for (r, reg) in regions.iter().enumerate() {
        if reg.kind != Kind::Face
            || !reg
                .tris
                .iter()
                .any(|&t| mesh.triangles[t].iter().any(|&v| drop(v)))
        {
            continue;
        }
        // the outline through its corners only
        let segs = rim(r);
        let mut next: FxHashMap<u32, u32> = segs.iter().copied().collect();
        let mut loops = Vec::new();
        while let Some((&s0, _)) = next.iter().find(|(a, _)| !drop(**a)) {
            let mut a = s0;
            let mut guard = 0;
            loop {
                let mut b = next.remove(&a)?;
                while drop(b) {
                    b = next.remove(&b)?;
                    guard += 1;
                    if guard > segs.len() {
                        return None;
                    }
                }
                loops.push((a, b));
                a = b;
                if a == s0 {
                    break;
                }
            }
        }
        if !next.is_empty() {
            return None; // a loop of dropped vertices only
        }
        let got = fill(&mut positions, &loops, reg.normal, false, 0.0, 0)?;
        for &t in &reg.tris {
            done[t] = true;
        }
        let fid = ids_for(mesh, &positions, &reg.tris, &got, ids);
        filled_at.insert(reg.tris.iter().copied().min().unwrap_or(0), (got, fid));
    }
    let id_of = |t: usize| ids.map_or(0, |ids| ids[t]);
    let mut triangles = Vec::with_capacity(n);
    let mut out_ids = Vec::with_capacity(n);
    #[allow(clippy::needless_range_loop, reason = "t indexes several tables")]
    for t in 0..n {
        if let Some((f, fid)) = filled_at.remove(&t) {
            out_ids.extend(fid);
            triangles.extend(f);
        } else if !done[t] {
            triangles.push(mesh.triangles[t]);
            out_ids.push(id_of(t));
        }
    }
    let mut out = TriMesh::new(positions, triangles);
    if let Some(f) = &mesh.faces {
        out.faces = Some(Faces {
            ids: out_ids,
            table: f.table.clone(),
            keys: f.keys.clone(),
        });
    }
    let out = compact(out);
    if !out.edge_report().is_watertight()
        || (out.volume() - mesh.volume()).abs() > 1e-6 * mesh.volume().abs().max(1.0)
    {
        return None;
    }
    Some(out)
}

/// fills the closed outline `segs` (directed edges, the region on their left seen along `normal`) with triangles;
/// refined to `angle` degrees with interior points when `refine`, the outline kept as it is
fn fill(
    positions: &mut Vec<V3>,
    segs: &[(u32, u32)],
    normal: V3,
    refine: bool,
    angle: f64,
    budget: usize,
) -> Option<Vec<[u32; 3]>> {
    let u = vec3::normalize(vec3::any_perpendicular(normal))?;
    let v = vec3::cross(normal, u);
    let o = positions[segs.first()?.0 as usize];
    let flat = |p: V3| {
        let d = vec3::sub(p, o);
        Point2::new(vec3::dot(d, u), vec3::dot(d, v))
    };
    let mut cdt: ConstrainedDelaunayTriangulation<Point2<f64>> = ConstrainedDelaunayTriangulation::new();
    let mut handle: FxHashMap<u32, spade::handles::FixedVertexHandle> = FxHashMap::default();
    let mut index: FxHashMap<spade::handles::FixedVertexHandle, u32> = FxHashMap::default();
    for &(a, b) in segs {
        for i in [a, b] {
            if let std::collections::hash_map::Entry::Vacant(e) = handle.entry(i) {
                let h = cdt.insert(flat(positions[i as usize])).ok()?;
                if index.insert(h, i).is_some_and(|j| j != i) {
                    return None; // two vertices at one place
                }
                e.insert(h);
            }
        }
    }
    for &(a, b) in segs {
        let (ha, hb) = (handle[&a], handle[&b]);
        if ha == hb {
            continue;
        }
        if !cdt.can_add_constraint(ha, hb) {
            return None;
        }
        cdt.add_constraint(ha, hb);
    }
    let area_before = signed_area(positions, segs, &flat);
    let outer: std::collections::HashSet<_> = if refine {
        let params = RefinementParameters::<f64>::new()
            .exclude_outer_faces(true)
            .keep_constraint_edges()
            .with_angle_limit(AngleLimit::from_deg(angle))
            .with_max_additional_vertices(budget.min(segs.len() * 40 + 200));
        cdt.refine(params).excluded_faces.into_iter().collect()
    } else {
        let params = RefinementParameters::<f64>::new()
            .exclude_outer_faces(true)
            .keep_constraint_edges()
            .with_max_additional_vertices(0);
        cdt.refine(params).excluded_faces.into_iter().collect()
    };
    let mut out = Vec::new();
    let mut area = 0.0;
    for f in cdt.inner_faces() {
        if outer.contains(&f.fix()) {
            continue;
        }
        let vs = f.vertices();
        let mut tri = [0u32; 3];
        for (k, vh) in vs.iter().enumerate() {
            let fx = vh.fix();
            tri[k] = if let Some(&i) = index.get(&fx) {
                i
            } else {
                // a point refinement added inside the face
                let p = vh.position();
                let i = u32::try_from(positions.len()).ok()?;
                positions.push(vec3::add(o, vec3::add(vec3::scale(u, p.x), vec3::scale(v, p.y))));
                index.insert(fx, i);
                i
            };
        }
        let [a, b, c] = vs.map(|h| h.position());
        area += ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2.0;
        out.push(tri);
    }
    // the faces cover the outline exactly, or nothing changes
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for &(a, _) in segs {
        let p = flat(positions[a as usize]);
        lo = [lo[0].min(p.x), lo[1].min(p.y)];
        hi = [hi[0].max(p.x), hi[1].max(p.y)];
    }
    let extent = (hi[0] - lo[0]).max(hi[1] - lo[1]).max(0.0);
    if (area - area_before).abs() > 1e-9 * area_before.abs() + 1e-10 * extent * extent || out.is_empty() {
        return None;
    }
    Some(out)
}

fn signed_area(positions: &[V3], segs: &[(u32, u32)], flat: &impl Fn(V3) -> Point2<f64>) -> f64 {
    segs.iter()
        .map(|&(a, b)| {
            let (p, q) = (flat(positions[a as usize]), flat(positions[b as usize]));
            p.x * q.y - q.x * p.y
        })
        .sum::<f64>()
        / 2.0
}

/// triangles with no area (a corner on the opposite edge) flipped away with the triangle across their long edge:
/// (a, b, c) with c on ab and (b, a, d) across it become (a, c, d) and (c, b, d). The count flipped.
fn drop_needles(m: &mut TriMesh) -> usize {
    let tol = m.bounds().map_or(1e-6, |b| (b.diagonal() * 1e-7).max(1e-9));
    let mut flipped = 0;
    for _ in 0..4 {
        let mut edges: FxHashMap<Edge, Vec<usize>> = FxHashMap::default();
        for (t, tri) in m.triangles.iter().enumerate() {
            for k in 0..3 {
                edges.entry(key(tri[k], tri[(k + 1) % 3])).or_default().push(t);
            }
        }
        let mut busy = vec![false; m.triangles.len()];
        let mut changed = false;
        for t in 0..m.triangles.len() {
            if busy[t] {
                continue;
            }
            let tri = m.triangles[t];
            let p = tri.map(|i| m.positions[i as usize]);
            // the longest edge and the corner across it
            let k = (0..3)
                .max_by(|&x, &y| {
                    let lx = vec3::len(vec3::sub(p[(x + 1) % 3], p[x]));
                    let ly = vec3::len(vec3::sub(p[(y + 1) % 3], p[y]));
                    lx.total_cmp(&ly)
                })
                .unwrap_or(0);
            let (a, b, c) = (tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]);
            let (pa, pb, pc) = (
                m.positions[a as usize],
                m.positions[b as usize],
                m.positions[c as usize],
            );
            let ab = vec3::sub(pb, pa);
            let l = vec3::len(ab);
            if l <= 0.0 || vec3::len(vec3::cross(ab, vec3::sub(pc, pa))) / l > tol {
                continue;
            }
            let Some(&o) = edges.get(&key(a, b)).and_then(|v| v.iter().find(|&&o| o != t)) else {
                continue;
            };
            if busy[o] {
                continue;
            }
            let ot = m.triangles[o];
            let Some(d) = ot.iter().copied().find(|&v| v != a && v != b) else {
                continue;
            };
            // o split at c, keeping its winding (b to a when the mesh is oriented)
            if (0..3).any(|j| ot[j] == b && ot[(j + 1) % 3] == a) {
                m.triangles[t] = [c, a, d];
                m.triangles[o] = [b, c, d];
            } else {
                m.triangles[t] = [a, c, d];
                m.triangles[o] = [c, b, d];
            }
            if let Some(f) = m.faces.as_mut() {
                f.ids[t] = f.ids[o];
            }
            busy[t] = true;
            busy[o] = true;
            flipped += 1;
            changed = true;
        }
        if !changed {
            break;
        }
    }
    flipped
}

/// the face id of each new triangle: the one of the old triangle its middle is in. Regions are found by their plane
/// alone, so a mesh gives the same triangles with face ids or without, and the ids follow where they were.
fn ids_for(
    mesh: &TriMesh,
    positions: &[V3],
    old: &[usize],
    new: &[[u32; 3]],
    ids: Option<&Vec<u32>>,
) -> Vec<u32> {
    let Some(ids) = ids else { return vec![0; new.len()] };
    let corners = |t: &[u32; 3]| t.map(|i| positions[i as usize]);
    new.iter()
        .map(|t| {
            let [a, b, c] = corners(t);
            let m = vec3::scale(vec3::add(vec3::add(a, b), c), 1.0 / 3.0);
            let inside = |o: usize| {
                let [p, q, r] = mesh.triangles[o].map(|i| mesh.positions[i as usize]);
                let n = vec3::cross(vec3::sub(q, p), vec3::sub(r, p));
                [(p, q), (q, r), (r, p)]
                    .iter()
                    .all(|&(x, y)| vec3::dot(vec3::cross(vec3::sub(y, x), vec3::sub(m, x)), n) >= -1e-12)
            };
            let o = old.iter().copied().find(|&o| inside(o)).unwrap_or(old[0]);
            ids[o]
        })
        .collect()
}

/// a count from a float, 0 for anything not positive
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to a positive range first"
)]
fn count(x: f64) -> usize {
    if x.is_finite() && x > 0.0 {
        x.min(1e12) as usize
    } else {
        0
    }
}

/// drops vertices no triangle uses
fn compact(mut m: TriMesh) -> TriMesh {
    let mut map = vec![u32::MAX; m.positions.len()];
    let mut next = Vec::new();
    for t in &mut m.triangles {
        for i in t.iter_mut() {
            let j = *i as usize;
            if map[j] == u32::MAX {
                map[j] = u32::try_from(next.len()).unwrap_or(u32::MAX);
                next.push(m.positions[j]);
            }
            *i = map[j];
        }
    }
    m.positions = next;
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worst(m: &TriMesh) -> f64 {
        m.triangles
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|i| m.positions[i as usize]);
                min_angle(a, b, c)
            })
            .fold(180.0, f64::min)
    }

    /// a long thin box with extra points along one long side, its caps fans from one corner
    fn fan_box() -> TriMesh {
        let (l, w, h) = (80.0, 6.0, 4.0);
        let n = 12u32;
        let mut p = vec![];
        for z in [0.0, h] {
            p.push([0.0, 0.0, z]);
            for i in 1..=n {
                p.push([l * f64::from(i) / f64::from(n), 0.0, z]);
            }
            p.push([l, w, z]);
            p.push([0.0, w, z]);
        }
        let r = n + 3; // points per ring
        let mut t = vec![];
        for i in 0..r - 2 {
            t.push([r - 1, i + 1, i]); // bottom, facing down
            t.push([r + r - 1, r + i, r + i + 1]); // top, facing up
        }
        for i in 0..r {
            let j = (i + 1) % r;
            t.push([i, j, r + j]);
            t.push([i, r + j, r + i]);
        }
        TriMesh::new(p, t)
    }

    #[test]
    fn fills_fanned_caps_with_good_triangles() {
        let m = fan_box();
        assert!(m.edge_report().is_watertight());
        assert!(worst(&m) < 5.0);
        let out = remesh_flat(&m, &RemeshOptions::default());
        eprintln!(
            "tris {} -> {}, inner {:?}",
            m.triangles.len(),
            out.triangles.len(),
            remesh_inner(&m, &RemeshOptions::default()).map(|o| o.triangles.len())
        );
        assert!(out.edge_report().is_watertight());
        assert!((out.volume() - m.volume()).abs() < 1e-9 * m.volume());
        assert!(worst(&out) > 12.0, "{}", worst(&out));
    }

    #[test]
    fn coarsening_takes_the_points_off_straight_edges() {
        let m = fan_box();
        let out = coarsen_flat(&m);
        assert!(out.edge_report().is_watertight());
        assert_eq!(out.triangles.len(), 12, "a box again");
        assert!((out.volume() - m.volume()).abs() < 1e-9 * m.volume());
        // and filling again puts good triangles back
        let again = remesh_flat(&out, &RemeshOptions::default());
        assert!(again.edge_report().is_watertight());
        assert!(worst(&again) > 12.0, "{}", worst(&again));
    }

    #[test]
    fn leaves_a_good_mesh_alone() {
        let p = vec![
            [0.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
            [0.0, 10.0, 0.0],
            [0.0, 0.0, 10.0],
        ];
        let m = TriMesh::new(p, vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);
        assert_eq!(remesh_flat(&m, &RemeshOptions::default()), m);
    }
}
