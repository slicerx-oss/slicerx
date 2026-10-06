// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! fillet and chamfer on the straight edges where two flat faces meet, and on the round edge where a flat face
//! meets a cylinder square to it (`rim`)
// triangle, region and ring indices come from the validated mesh and the
// lists built here
#![allow(clippy::indexing_slicing)]

use crate::boolean::{self, BoolOp, BooleanOptions, BooleanReport, Solid};
use crate::build;
use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::measure::{SHARP_DEG, Topology};
use crate::mesh::TriMesh;
use crate::poly2d::Polygon;
use crate::vec3::{self, Frame, V2, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::f64::consts::PI;

mod rim;

#[cfg(feature = "holes")]
pub(crate) use rim::{Rim, rims_on};

const MARGIN_MM: f64 = 0.01;
const MAX_MM: f64 = 1000.0;
pub const DEFAULT_TOLERANCE_MM: f64 = 0.01;
const CHAIN_DEG: f64 = 20.0;
/// triangles within this many degrees of a face's normal belong to it
const FLAT_DEG: f64 = 0.5;
/// lowest tolerance for finding an edge reference again, millimeters
const REF_MM: f64 = 0.001;

type Key = [u64; 3];

fn key(p: V3) -> Key {
    p.map(|c| (c + 0.0).to_bits())
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeRef {
    pub a: V3,
    pub b: V3,
    pub face: V3,
    /// the ends moved with a face they lie on (a history replay): the edge is found along its line
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub moved: bool,
    /// a round edge: the center of the circle where the face `face` meets a cylinder square to it; `a` is a
    /// corner of the circle and `b` the same point
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<V3>,
    /// The keys of the two faces either side (faces.rs), the one `face` faces first: the edge is found again
    /// between those faces before it is looked for at `a` and `b` (docs/cad-history.md, "Face keys").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<[u64; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeFace {
    pub normal: V3,
    pub curved: bool,
    pub triangles: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopEdge {
    pub edge: EdgeRef,
    pub supported: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgePick {
    pub edge: EdgeRef,
    pub length_mm: f64,
    pub faces: Vec<EdgeFace>,
    pub dihedral_deg: f64,
    pub convex: bool,
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub max_distance_mm: [f64; 2],
    pub max_radius_mm: f64,
    pub chain: Vec<EdgeRef>,
    #[serde(rename = "loop")]
    pub ring: Vec<LoopEdge>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Profile {
    Chamfer { d1: f64, d2: f64 },
    Fillet { radius: f64, tolerance: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeInfo {
    pub convex: bool,
    pub dihedral_deg: f64,
    pub length_mm: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Corner {
    pub at: V3,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Default)]
struct Tools {
    pub cut: Vec<TriMesh>,
    pub join: Vec<TriMesh>,
    pub edges: Vec<EdgeInfo>,
    pub corners: Vec<Corner>,
    pub refs: Vec<EdgeRef>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeReport {
    pub volume_change_mm3: f64,
    pub shells: usize,
    pub watertight: bool,
    pub boolean: BooleanReport,
}

#[derive(Debug, Clone)]
pub struct EdgeResult {
    pub mesh: TriMesh,
    pub report: EdgeReport,
    pub edges: Vec<EdgeInfo>,
    pub corners: Vec<Corner>,
    /// Each edge as it was found, with its faces' keys, for the history step to keep.
    pub refs: Vec<EdgeRef>,
    /// What was found another way than asked, in words ("edge 1 was split in two; ...").
    pub notes: Vec<String>,
}

struct Region {
    normal: V3,
    point: V3,
    curved: bool,
    tris: Vec<u32>,
}

struct Faces<'a> {
    topo: Topology<'a>,
    of: Vec<usize>,
    regions: Vec<Region>,
    at_vertex: HashMap<Key, Vec<usize>>,
    size: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Across {
    Face(usize, u32),
    Open,
    Many,
}

impl Across {
    fn same(self, o: Self) -> bool {
        match (self, o) {
            (Self::Face(a, _), Self::Face(b, _)) => a == b,
            _ => self == o,
        }
    }
}

#[derive(Clone, Copy)]
struct Run {
    a: V3,
    b: V3,
    tri: u32,
    across: Across,
}

impl<'a> Faces<'a> {
    fn new(mesh: &'a TriMesh) -> Self {
        let topo = Topology::new(mesh);
        let n = mesh.triangles.len();
        let size = mesh.bounds().map_or(1.0, |b| b.diagonal()).max(1e-9);
        let tol = (size * 1e-6).max(1e-6).max(size * 1e-4);
        let cos = FLAT_DEG.to_radians().m_cos();
        let mut of = vec![usize::MAX; n];
        let mut regions = Vec::new();
        for seed in 0..n {
            if of[seed] != usize::MAX {
                continue;
            }
            let id = regions.len();
            let n0 = topo.normals[seed];
            #[allow(clippy::cast_possible_truncation, reason = "triangle counts fit u32")]
            let s = seed as u32;
            let p0 = topo.corners(s)[0];
            of[seed] = id;
            let mut stack = vec![s];
            let mut tris = Vec::new();
            let mut acc = [0.0; 3];
            while let Some(t) = stack.pop() {
                tris.push(t);
                let c = topo.corners(t);
                acc = vec3::add(acc, vec3::tri_normal(c[0], c[1], c[2]));
                for (nb, _, _) in topo.neighbors(t) {
                    let k = nb as usize;
                    if of[k] == usize::MAX
                        && vec3::dot(topo.normals[k], n0) > cos
                        && topo
                            .corners(nb)
                            .iter()
                            .all(|&p| vec3::dot(vec3::sub(p, p0), n0).abs() < tol)
                    {
                        of[k] = id;
                        stack.push(nb);
                    }
                }
            }
            tris.sort_unstable();
            regions.push(Region {
                normal: vec3::normalize(acc).unwrap_or(n0),
                point: p0,
                curved: false,
                tris,
            });
        }
        // a facet of a curved surface meets facets of its own size across smooth edges; a flat face
        // beside a fillet meets strips much smaller than itself and stays flat
        let mut area = vec![0.0; regions.len()];
        for t in 0..n {
            #[allow(clippy::cast_possible_truncation, reason = "triangle counts fit u32")]
            let c = topo.corners(t as u32);
            area[of[t]] += vec3::len(vec3::tri_normal(c[0], c[1], c[2])) * 0.5;
        }
        let mut at_vertex: HashMap<Key, Vec<usize>> = HashMap::new();
        for (t, tri) in mesh.triangles.iter().enumerate() {
            #[allow(clippy::cast_possible_truncation, reason = "triangle counts fit u32")]
            let tu = t as u32;
            for (nb, a, b) in topo.neighbors(tu) {
                let (r, o) = (of[t], of[nb as usize]);
                if o != r && !topo.is_sharp(a, b) && area[o] * 4.0 > area[r] {
                    regions[r].curved = true;
                }
            }
            for &v in tri {
                let list = at_vertex.entry(key(mesh.positions[v as usize])).or_default();
                if !list.contains(&of[t]) {
                    list.push(of[t]);
                }
            }
        }
        Self {
            topo,
            of,
            regions,
            at_vertex,
            size,
        }
    }

    fn tol(&self) -> f64 {
        (self.size * 1e-7).max(1e-7)
    }

    fn boundary(&self, r: usize) -> Vec<Run> {
        let mut out = Vec::new();
        for &t in &self.regions[r].tris {
            let c = self.topo.corners(t);
            for j in 0..3 {
                let (a, b) = (c[j], c[(j + 1) % 3]);
                let f = self.topo.edge_faces(a, b);
                if f.iter().any(|&n| n != t && self.of[n as usize] == r) {
                    continue;
                }
                let others: Vec<u32> = f.iter().copied().filter(|&n| n != t).collect();
                let across = match others.as_slice() {
                    [] => Across::Open,
                    [n] => Across::Face(self.of[*n as usize], *n),
                    _ => Across::Many,
                };
                out.push(Run { a, b, tri: t, across });
            }
        }
        out
    }

    fn rings(&self, r: usize) -> Vec<Vec<Run>> {
        let edges = self.boundary(r);
        let mut next: HashMap<Key, Vec<usize>> = HashMap::new();
        for (i, e) in edges.iter().enumerate() {
            next.entry(key(e.a)).or_default().push(i);
        }
        let mut used = vec![false; edges.len()];
        let mut rings = Vec::new();
        for s in 0..edges.len() {
            if used[s] {
                continue;
            }
            let mut ring = Vec::new();
            let mut i = s;
            loop {
                used[i] = true;
                ring.push(edges[i]);
                let Some(j) = next
                    .get(&key(edges[i].b))
                    .and_then(|c| c.iter().copied().find(|&j| !used[j]))
                else {
                    break;
                };
                i = j;
            }
            rings.push(runs_of(&ring));
        }
        rings
    }
}

fn runs_of(ring: &[Run]) -> Vec<Run> {
    let n = ring.len();
    let start = (0..n)
        .find(|&i| !ring[i].across.same(ring[(i + n - 1) % n].across))
        .unwrap_or(0);
    let mut runs: Vec<Run> = Vec::new();
    for k in 0..n {
        let e = ring[(start + k) % n];
        match runs.last_mut() {
            Some(r) if r.across.same(e.across) && key(r.b) == key(e.a) => r.b = e.b,
            _ => runs.push(e),
        }
    }
    runs
}

fn centroid(c: [V3; 3]) -> V3 {
    vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0)
}

fn inward(faces: &Faces<'_>, n: V3, d: V3, a: V3, tri: u32) -> Option<V3> {
    let t = vec3::normalize(vec3::cross(n, d))?;
    let c = vec3::sub(centroid(faces.topo.corners(tri)), a);
    Some(if vec3::dot(t, c) < 0.0 {
        vec3::scale(t, -1.0)
    } else {
        t
    })
}

fn dist_to_segment(p: V3, a: V3, b: V3) -> f64 {
    let ab = vec3::sub(b, a);
    let l2 = vec3::dot(ab, ab);
    let t = if l2 > 0.0 {
        (vec3::dot(vec3::sub(p, a), ab) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    vec3::len(vec3::sub(p, vec3::add(a, vec3::scale(ab, t))))
}

#[derive(Clone, Copy)]
struct End {
    point: V3,
    normal: V3,
    extend: bool,
}

#[derive(Clone, Copy)]
struct Geom {
    a: V3,
    b: V3,
    d: V3,
    len: f64,
    ra: usize,
    rb: usize,
    ta: V3,
    tb: V3,
    /// angle between `ta` and `tb`, radians, below pi
    phi: f64,
    convex: bool,
    ends: [End; 2],
}

impl Geom {
    fn dihedral_deg(&self) -> f64 {
        let p = self.phi.to_degrees();
        if self.convex { p } else { 360.0 - p }
    }

    fn reach(&self, i: usize, p: V3, offset: f64) -> f64 {
        let e = self.ends[i];
        (offset + vec3::dot(e.normal, vec3::sub(e.point, p))) / vec3::dot(e.normal, self.d)
    }

    fn end_offset(&self, i: usize) -> f64 {
        let e = self.ends[i];
        if !e.extend {
            return 0.0;
        }
        let out = if i == 0 { vec3::scale(self.d, -1.0) } else { self.d };
        MARGIN_MM.copysign(vec3::dot(out, e.normal))
    }

    fn strip(&self, side: usize, w: f64) -> Option<[V3; 4]> {
        let t = if side == 0 { self.ta } else { self.tb };
        let p = vec3::add(self.a, vec3::scale(t, w));
        let (x0, x1) = (self.reach(0, p, 0.0), self.reach(1, p, 0.0));
        if !(x1 - x0 > 1e-9 && x0.is_finite() && x1.is_finite()) {
            return None;
        }
        Some([
            self.a,
            self.b,
            vec3::add(p, vec3::scale(self.d, x1)),
            vec3::add(p, vec3::scale(self.d, x0)),
        ])
    }
}

fn geom(
    faces: &Faces<'_>,
    ra: usize,
    rb: usize,
    a: V3,
    b: V3,
    tri_a: u32,
    tri_b: u32,
) -> std::result::Result<Geom, String> {
    let (fa, fb) = (&faces.regions[ra], &faces.regions[rb]);
    if fa.curved {
        return Err("The picked face is curved. Fillet and chamfer work between flat faces only.".into());
    }
    if fb.curved {
        return Err(
            "The face across the edge is curved. Fillet and chamfer work between flat faces only.".into(),
        );
    }
    let ab = vec3::sub(b, a);
    let len = vec3::len(ab);
    let d = vec3::normalize(ab).ok_or_else(|| "The edge has no length.".to_owned())?;
    let (Some(ta), Some(tb)) = (
        inward(faces, fa.normal, d, a, tri_a),
        inward(faces, fb.normal, d, a, tri_b),
    ) else {
        return Err("The faces along this edge are not flat enough to tell apart.".into());
    };
    let phi = vec3::dot(ta, tb).clamp(-1.0, 1.0).m_acos();
    if phi > PI - SHARP_DEG.to_radians() * 0.5 || phi < 1e-3 {
        return Err("The faces along this edge meet too flat or too sharp to round.".into());
    }
    let convex = vec3::dot(fa.normal, tb) < 0.0;
    let mut ends = [End {
        point: a,
        normal: d,
        extend: false,
    }; 2];
    for (i, p) in [a, b].into_iter().enumerate() {
        let others: Vec<usize> = faces
            .at_vertex
            .get(&key(p))
            .map(|l| l.iter().copied().filter(|&r| r != ra && r != rb).collect())
            .unwrap_or_default();
        let c = match others.as_slice() {
            [c] => *c,
            [] => return Err("The edge ends where only its own two faces meet.".into()),
            _ => return Err("The edge ends where more than three faces meet.".into()),
        };
        let fc = &faces.regions[c];
        if fc.curved {
            return Err("The edge ends at a curved face.".into());
        }
        let out = if i == 0 { vec3::scale(d, -1.0) } else { d };
        let along = vec3::dot(out, fc.normal);
        if along.abs() < 0.05 {
            return Err("The edge meets the face at its end at too shallow an angle.".into());
        }
        ends[i] = End {
            point: p,
            normal: fc.normal,
            extend: if convex { along > 0.0 } else { along < 0.0 },
        };
    }
    Ok(Geom {
        a,
        b,
        d,
        len,
        ra,
        rb,
        ta,
        tb,
        phi,
        convex,
        ends,
    })
}

fn quad_fits(faces: &Faces<'_>, r: usize, quad: &[V3; 4]) -> bool {
    let f = &faces.regions[r];
    let Some(frame) = Frame::from_normal(f.point, f.normal, Some(vec3::sub(quad[1], quad[0]))) else {
        return false;
    };
    let q: Vec<V2> = quad.iter().map(|&p| frame.project(p)).collect();
    let area = crate::poly2d::signed_area(&q);
    if area.abs() < 1e-12 {
        return false;
    }
    let sgn = area.signum();
    let eps = faces.tol() * 10.0 + 1e-9;
    // inward half planes n.p >= c, moved in by eps
    let planes: Vec<(V2, f64)> = (0..4)
        .map(|i| {
            let (p, n) = (q[i], q[(i + 1) % 4]);
            let e = [n[0] - p[0], n[1] - p[1]];
            let l = e[0].m_hypot(e[1]).max(1e-300);
            let inward = [-e[1] * sgn / l, e[0] * sgn / l];
            (inward, inward[0] * p[0] + inward[1] * p[1] + eps)
        })
        .collect();
    let mut crossings = 0usize;
    let c = [
        q.iter().map(|p| p[0]).sum::<f64>() / 4.0,
        q.iter().map(|p| p[1]).sum::<f64>() / 4.0,
    ];
    for e in faces.boundary(r) {
        let (p0, p1) = (frame.project(e.a), frame.project(e.b));
        let (mut t0, mut t1) = (0.0f64, 1.0f64);
        for &(n, k) in &planes {
            let f0 = n[0] * p0[0] + n[1] * p0[1] - k;
            let f1 = n[0] * p1[0] + n[1] * p1[1] - k;
            if f0 < 0.0 && f1 < 0.0 {
                t1 = -1.0;
                break;
            }
            if f0 < 0.0 {
                t0 = t0.max(f0 / (f0 - f1));
            } else if f1 < 0.0 {
                t1 = t1.min(f0 / (f0 - f1));
            }
        }
        if t1 - t0 > 1e-12 {
            return false;
        }
        if (p0[1] > c[1]) != (p1[1] > c[1]) {
            let x = p0[0] + (c[1] - p0[1]) / (p1[1] - p0[1]) * (p1[0] - p0[0]);
            if x > c[0] {
                crossings += 1;
            }
        }
    }
    crossings % 2 == 1
}

fn fits(faces: &Faces<'_>, g: &Geom, side: usize, w: f64) -> bool {
    let r = if side == 0 { g.ra } else { g.rb };
    g.strip(side, w).is_some_and(|q| quad_fits(faces, r, &q))
}

fn max_width(faces: &Faces<'_>, g: &Geom, side: usize) -> f64 {
    let (mut lo, mut hi) = (0.0, faces.size.min(MAX_MM));
    if fits(faces, g, side, hi) {
        return hi;
    }
    for _ in 0..48 {
        let mid = f64::midpoint(lo, hi);
        if fits(faces, g, side, mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

fn setback(g: &Geom, r: f64) -> f64 {
    r / (g.phi * 0.5).m_tan()
}

#[allow(
    clippy::too_many_lines,
    reason = "the pick, its faces, chain and loop in one pass"
)]
pub fn pick_edge(mesh: &TriMesh, triangle: u32, at: V3) -> Result<EdgePick> {
    mesh.validate("edge")?;
    if triangle as usize >= mesh.triangles.len() {
        return Err(Error::invalid("triangle", "out of range"));
    }
    if !at.iter().all(|c| c.is_finite()) {
        return Err(Error::invalid("at", "must be finite"));
    }
    let faces = Faces::new(mesh);
    let r = faces.of[triangle as usize];
    let rings = faces.rings(r);
    let mut best: Option<(f64, usize, usize)> = None;
    for (i, ring) in rings.iter().enumerate() {
        for (j, run) in ring.iter().enumerate() {
            let sharp = match run.across {
                Across::Face(rb, _) => {
                    vec3::dot(faces.regions[r].normal, faces.regions[rb].normal)
                        < SHARP_DEG.to_radians().m_cos()
                }
                _ => true,
            };
            if !sharp {
                continue;
            }
            let dist = dist_to_segment(at, run.a, run.b);
            if best.is_none_or(|(bd, _, _)| dist < bd) {
                best = Some((dist, i, j));
            }
        }
    }
    let Some((_, i, j)) = best else {
        return Err(Error::invalid("edge", "pick near the edge of a flat face"));
    };
    let ring = &rings[i];
    let run = ring[j];
    let face_of = |reg: usize| EdgeFace {
        normal: faces.regions[reg].normal,
        curved: faces.regions[reg].curved,
        triangles: faces.regions[reg].tris.clone(),
    };
    // A round edge always names itself by the same corner, so picking it again from anywhere matches.
    if let Some(rim) = rim::at_edge(mesh, run.a, run.b) {
        let edge = EdgeRef {
            a: rim.start,
            b: rim.start,
            face: rim.normal,
            moved: false,
            center: Some(rim.center),
            keys: None,
        };
        let floor = |w: f64| (w * 1000.0 + 1e-6).floor() / 1000.0;
        let room = rim.room.map(floor);
        let mut out_faces = vec![face_of(r)];
        if let Across::Face(rb, _) = run.across {
            out_faces.push(face_of(rb));
        }
        return Ok(EdgePick {
            edge,
            length_mm: rim.length(),
            faces: out_faces,
            dihedral_deg: rim.dihedral_deg(),
            convex: rim.convex,
            supported: true,
            reason: None,
            max_distance_mm: room,
            max_radius_mm: floor((room[0].min(room[1]) * (rim.geom().phi * 0.5).m_tan()).min(MAX_MM)),
            chain: vec![edge],
            ring: vec![LoopEdge {
                edge,
                supported: true,
            }],
        });
    }
    let edge = EdgeRef {
        a: run.a,
        b: run.b,
        face: faces.regions[r].normal,
        moved: false,
        center: None,
        keys: None,
    };
    let mut out = EdgePick {
        edge,
        length_mm: vec3::len(vec3::sub(run.b, run.a)),
        faces: vec![face_of(r)],
        dihedral_deg: 0.0,
        convex: false,
        supported: false,
        reason: None,
        max_distance_mm: [0.0; 2],
        max_radius_mm: 0.0,
        chain: vec![edge],
        ring: Vec::new(),
    };
    let geom_of = |run: &Run| -> std::result::Result<Geom, String> {
        match run.across {
            Across::Face(rb, tb) => geom(&faces, r, rb, run.a, run.b, run.tri, tb),
            Across::Open => Err("The mesh is open along this edge.".into()),
            Across::Many => Err("More than two faces meet along this edge.".into()),
        }
    };
    if let Across::Face(rb, _) = run.across {
        out.faces.push(face_of(rb));
    }
    match geom_of(&run) {
        Ok(g) => {
            out.dihedral_deg = g.dihedral_deg();
            out.convex = g.convex;
            out.supported = true;
            // whole micrometers, rounded down, so the numbers shown fit
            let floor = |w: f64| (w * 1000.0 + 1e-6).floor() / 1000.0;
            out.max_distance_mm = [floor(max_width(&faces, &g, 0)), floor(max_width(&faces, &g, 1))];
            let w = out.max_distance_mm[0].min(out.max_distance_mm[1]);
            out.max_radius_mm = floor((w * (g.phi * 0.5).m_tan()).min(MAX_MM));
        }
        Err(why) => {
            if let Across::Face(rb, tb) = run.across {
                let n0 = faces.regions[r].normal;
                let n1 = faces.regions[rb].normal;
                let d = vec3::normalize(vec3::sub(run.b, run.a)).unwrap_or([1.0, 0.0, 0.0]);
                let t1 = inward(&faces, n1, d, run.a, tb).unwrap_or([0.0; 3]);
                let t0 = inward(&faces, n0, d, run.a, run.tri).unwrap_or([0.0; 3]);
                let phi = vec3::dot(t0, t1).clamp(-1.0, 1.0).m_acos().to_degrees();
                out.convex = vec3::dot(n0, t1) < 0.0;
                out.dihedral_deg = if out.convex { phi } else { 360.0 - phi };
            }
            out.reason = Some(why);
        }
    }
    let n = ring.len();
    let ok = |run: &Run| geom_of(run).is_ok();
    let dir = |run: &Run| vec3::normalize(vec3::sub(run.b, run.a)).unwrap_or([0.0; 3]);
    let cos = CHAIN_DEG.to_radians().m_cos();
    let to_ref = |run: &Run| EdgeRef {
        a: run.a,
        b: run.b,
        face: faces.regions[r].normal,
        moved: false,
        center: None,
        keys: None,
    };
    if out.supported && n > 1 {
        let mut fwd = Vec::new();
        let mut k = j;
        for _ in 1..n {
            let nx = (k + 1) % n;
            if nx == j || !ok(&ring[nx]) || vec3::dot(dir(&ring[k]), dir(&ring[nx])) < cos {
                break;
            }
            fwd.push(to_ref(&ring[nx]));
            k = nx;
        }
        let mut back = Vec::new();
        k = j;
        for _ in 1..n {
            let pv = (k + n - 1) % n;
            if pv == j || fwd.iter().any(|e| key(e.a) == key(ring[pv].a)) {
                break;
            }
            if !ok(&ring[pv]) || vec3::dot(dir(&ring[pv]), dir(&ring[k])) < cos {
                break;
            }
            back.push(to_ref(&ring[pv]));
            k = pv;
        }
        back.reverse();
        back.push(edge);
        back.extend(fwd);
        out.chain = back;
    }
    out.ring = (0..n)
        .map(|k| {
            let run = &ring[(j + k) % n];
            LoopEdge {
                edge: to_ref(run),
                supported: ok(run),
            }
        })
        .collect();
    Ok(out)
}

fn check_size(what: &'static str, v: f64) -> Result<f64> {
    if v.is_finite() && v > 0.0 && v <= MAX_MM {
        Ok(v)
    } else {
        Err(Error::invalid(what, "must be above 0 (at most 1000 mm)"))
    }
}

fn check_profile(p: Profile) -> Result<Profile> {
    match p {
        Profile::Chamfer { d1, d2 } => Ok(Profile::Chamfer {
            d1: check_size("distanceMm", d1)?,
            d2: check_size("distance2Mm", d2)?,
        }),
        Profile::Fillet { radius, tolerance } => {
            if !(tolerance.is_finite() && (0.001..=1.0).contains(&tolerance)) {
                return Err(Error::invalid("toleranceMm", "must be from 0.001 to 1 mm"));
            }
            Ok(Profile::Fillet {
                radius: check_size("radiusMm", radius)?,
                tolerance,
            })
        }
    }
}

struct Along {
    covered: f64,
    tris: (u32, u32),
    lo: (f64, V3),
    hi: (f64, V3),
}

// one pass over the edge cases reads better than split helpers
#[allow(clippy::too_many_lines)]
fn resolve(faces: &Faces<'_>, n: usize, e: &EdgeRef) -> Result<Geom> {
    let why = format!("edge {n}: no sharp edge between two flat faces there");
    let none = || Error::invalid("edges", why.clone());
    if !(e.a.iter().chain(&e.b).chain(&e.face).all(|c| c.is_finite())) {
        return Err(Error::invalid(
            "edges",
            format!("edge {n}: points must be finite"),
        ));
    }
    let ab = vec3::sub(e.b, e.a);
    let len = vec3::len(ab);
    let d = vec3::normalize(ab).ok_or_else(none)?;
    let face = vec3::normalize(e.face).ok_or_else(none)?;
    let tol = REF_MM.max(faces.size * 1e-7);
    if len <= tol * 2.0 {
        return Err(none());
    }
    let param = |p: V3| vec3::dot(vec3::sub(p, e.a), d);
    let on = |p: V3| {
        let t = param(p);
        t > -tol && t < len + tol && dist_to_segment(p, e.a, e.b) < tol
    };
    let mut found: HashMap<(usize, usize), Along> = HashMap::new();
    let mesh = faces.topo.mesh;
    for (t, tri) in mesh.triangles.iter().enumerate() {
        let c = tri.map(|v| mesh.positions[v as usize]);
        for j in 0..3 {
            let (p, q) = (c[j], c[(j + 1) % 3]);
            if !(on(p) && on(q)) {
                continue;
            }
            let f = faces.topo.edge_faces(p, q);
            #[allow(clippy::cast_possible_truncation, reason = "triangle counts fit u32")]
            let tu = t as u32;
            if f.len() != 2 || f[0] != tu {
                continue;
            }
            let (r0, r1) = (faces.of[f[0] as usize], faces.of[f[1] as usize]);
            if r0 == r1 {
                continue;
            }
            let (pair, tris) = if r0 < r1 {
                ((r0, r1), (f[0], f[1]))
            } else {
                ((r1, r0), (f[1], f[0]))
            };
            let (tp, tq) = (param(p), param(q));
            let ent = found.entry(pair).or_insert(Along {
                covered: 0.0,
                tris,
                lo: (tp, p),
                hi: (tp, p),
            });
            ent.covered += vec3::len(vec3::sub(q, p));
            for (t, v) in [(tp, p), (tq, q)] {
                if t < ent.lo.0 {
                    ent.lo = (t, v);
                }
                if t > ent.hi.0 {
                    ent.hi = (t, v);
                }
            }
        }
    }
    let mut picks: Vec<Found> = Vec::new();
    for (&(r0, r1), al) in &found {
        if al.covered < len - tol * 4.0 {
            continue;
        }
        let (a, b) = (al.lo.1, al.hi.1);
        if vec3::len(vec3::sub(a, e.a)) > tol || vec3::len(vec3::sub(b, e.b)) > tol {
            continue;
        }
        let (n0, n1) = (faces.regions[r0].normal, faces.regions[r1].normal);
        let (t0, t1) = al.tris;
        if vec3::dot(n0, face) > 0.999 {
            picks.push((r0, r1, t0, t1, a, b));
        } else if vec3::dot(n1, face) > 0.999 {
            picks.push((r1, r0, t1, t0, a, b));
        }
    }
    if picks.is_empty() && e.moved {
        picks = along_line(faces, n, e, face, tol)?;
    }
    let (ra, rb, ta, tb, a, b) = match picks.as_slice() {
        [] => return Err(none()),
        [p] => *p,
        _ => {
            return Err(Error::invalid(
                "edges",
                format!("edge {n}: more than one edge matches there; pick it again"),
            ));
        }
    };
    let g = geom(faces, ra, rb, a, b, ta, tb).map_err(|why| {
        Error::invalid(
            "edges",
            format!("edge {n}: {}", lower_first(why.trim_end_matches('.'))),
        )
    })?;
    if vec3::dot(faces.regions[ra].normal, faces.regions[rb].normal) > SHARP_DEG.to_radians().m_cos() {
        return Err(none());
    }
    Ok(g)
}

type Found = (usize, usize, u32, u32, V3, V3);
/// a piece of a line: from, at, to, at, and its two triangles
type Piece = (f64, V3, f64, V3, (u32, u32));

/// a moved reference: the sharp edges on its line that overlap it, each taken end to end
fn along_line(faces: &Faces<'_>, n: usize, e: &EdgeRef, face: V3, tol: f64) -> Result<Vec<Found>> {
    let gone = || {
        Error::invalid(
            "edges",
            format!("edge {n} moved with the face beside it and is not there any more; pick it again"),
        )
    };
    let ab = vec3::sub(e.b, e.a);
    let len = vec3::len(ab);
    let d = vec3::normalize(ab).ok_or_else(gone)?;
    let param = |p: V3| vec3::dot(vec3::sub(p, e.a), d);
    let off = |p: V3| vec3::len(vec3::sub(vec3::sub(p, e.a), vec3::scale(d, param(p))));
    // pieces on the line, by the pair of faces they divide
    let mut pieces: HashMap<(usize, usize), Vec<Piece>> = HashMap::new();
    let mesh = faces.topo.mesh;
    for (t, tri) in mesh.triangles.iter().enumerate() {
        let c = tri.map(|v| mesh.positions[v as usize]);
        for j in 0..3 {
            let (p, q) = (c[j], c[(j + 1) % 3]);
            if off(p) >= tol || off(q) >= tol {
                continue;
            }
            let f = faces.topo.edge_faces(p, q);
            #[allow(clippy::cast_possible_truncation, reason = "triangle counts fit u32")]
            let tu = t as u32;
            if f.len() != 2 || f[0] != tu {
                continue;
            }
            let (r0, r1) = (faces.of[f[0] as usize], faces.of[f[1] as usize]);
            if r0 == r1 {
                continue;
            }
            let (pair, tris) = if r0 < r1 {
                ((r0, r1), (f[0], f[1]))
            } else {
                ((r1, r0), (f[1], f[0]))
            };
            let (tp, tq) = (param(p), param(q));
            let piece = if tp <= tq {
                (tp, p, tq, q, tris)
            } else {
                (tq, q, tp, p, tris)
            };
            pieces.entry(pair).or_default().push(piece);
        }
    }
    let mut pairs: Vec<_> = pieces.into_iter().collect();
    pairs.sort_by_key(|(k, _)| *k);
    let mut out = Vec::new();
    for ((r0, r1), mut list) in pairs {
        list.sort_by(|x, y| x.0.total_cmp(&y.0));
        // runs without gaps
        let mut runs: Vec<Piece> = Vec::new();
        for pc in list {
            match runs.last_mut() {
                Some(r) if pc.0 <= r.2 + tol => {
                    if pc.2 > r.2 {
                        (r.2, r.3) = (pc.2, pc.3);
                    }
                }
                _ => runs.push(pc),
            }
        }
        for (lo, a, hi, b, (t0, t1)) in runs {
            if hi.min(len) - lo.max(0.0) <= tol {
                continue;
            }
            let (n0, n1) = (faces.regions[r0].normal, faces.regions[r1].normal);
            if vec3::dot(n0, face) > 0.999 {
                out.push((r0, r1, t0, t1, a, b));
            } else if vec3::dot(n1, face) > 0.999 {
                out.push((r1, r0, t1, t0, a, b));
            }
        }
    }
    if out.is_empty() {
        return Err(gone());
    }
    Ok(out)
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_lowercase().chain(c).collect())
        .unwrap_or_default()
}

fn section(g: &Geom, p: Profile) -> Vec<V2> {
    section_with(g, p, MARGIN_MM)
}

/// The cross section of the tool across the edge, reaching `m` past the faces where it leaves them.
fn section_with(g: &Geom, p: Profile, m: f64) -> Vec<V2> {
    let tb = [g.phi.m_cos(), g.phi.m_sin()];
    let ta = [1.0, 0.0];
    let half = g.phi * 0.5;
    let bis = [half.m_cos(), half.m_sin()];
    let q = [-bis[0] * m / half.m_sin(), -bis[1] * m / half.m_sin()];
    match p {
        Profile::Chamfer { d1, d2 } => {
            let pa = [d1, 0.0];
            let pb = [d2 * tb[0], d2 * tb[1]];
            let u = [pa[0] - pb[0], pa[1] - pb[1]];
            let l = u[0].m_hypot(u[1]);
            let u = [u[0] / l, u[1] / l];
            let sa = m / (u[0] * ta[1] - u[1] * ta[0]).abs().max(1e-3);
            let sb = m / (u[0] * tb[1] - u[1] * tb[0]).abs().max(1e-3);
            vec![
                q,
                [pa[0] + u[0] * sa, pa[1] + u[1] * sa],
                [pb[0] - u[0] * sb, pb[1] - u[1] * sb],
            ]
        }
        Profile::Fillet { radius, tolerance } => {
            let s = radius / half.m_tan();
            let c = [bis[0] * radius / half.m_sin(), bis[1] * radius / half.m_sin()];
            let pa = [s, 0.0];
            // the far end from the faces themselves rather than the angle, so it sits on its face
            // exactly (cos 90 is not 0) and a later cut along that face leaves no hairline flap
            let v = vec3::cross(g.d, g.ta);
            let pb = [s * vec3::dot(g.tb, g.ta), s * vec3::dot(g.tb, v).abs()];
            let a0 = (pa[1] - c[1]).m_atan2(pa[0] - c[0]);
            let sweep = -(PI - g.phi);
            let step = (1.0 - (tolerance / radius).min(1.0)).m_acos() * 2.0;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "clamped")]
            let n = if step > 0.0 {
                ((sweep.abs() / step).ceil() as usize).clamp(1, 256)
            } else {
                256
            };
            let out_a = [
                pa[0] + (pa[0] - c[0]) * m / radius,
                pa[1] + (pa[1] - c[1]) * m / radius,
            ];
            let out_b = [
                pb[0] + (pb[0] - c[0]) * m / radius,
                pb[1] + (pb[1] - c[1]) * m / radius,
            ];
            let mut ring = vec![q, out_a, pa];
            for i in 1..n {
                let a = a0 + sweep * i as f64 / n as f64;
                let (sn, cs) = a.m_sin_cos();
                ring.push([c[0] + radius * cs, c[1] + radius * sn]);
            }
            ring.push(pb);
            ring.push(out_b);
            ring
        }
    }
}

fn piece(g: &Geom, p: Profile, n: usize) -> Result<TriMesh> {
    let v = vec3::cross(g.d, g.ta);
    let frame = Frame {
        origin: g.a,
        u: g.ta,
        v,
        w: g.d,
    };
    let mut ring = section(g, p);
    if vec3::dot(g.tb, v) < 0.0 {
        for q in &mut ring {
            q[1] = -q[1];
        }
    }
    let (o0, o1) = (g.end_offset(0), g.end_offset(1));
    for &q in &ring {
        let base = frame.at(q, 0.0);
        if g.reach(1, base, o1) - g.reach(0, base, o0) < 1e-6 {
            return Err(Error::invalid(
                "edges",
                format!("edge {n} is too short for this size"),
            ));
        }
    }
    let mut m = build::extrude(&[Polygon::simple(ring)], &frame, 0.0, g.len)?;
    let half = g.len * 0.5;
    m.map_positions(|p| {
        let h = frame.height(p);
        let base = vec3::sub(p, vec3::scale(g.d, h));
        let t = if h < half {
            g.reach(0, base, o0)
        } else {
            g.reach(1, base, o1)
        };
        vec3::add(base, vec3::scale(g.d, t))
    });
    Ok(m)
}

fn solve3(n: [V3; 3], c: [f64; 3]) -> Option<V3> {
    let x12 = vec3::cross(n[1], n[2]);
    let det = vec3::dot(n[0], x12);
    if det.abs() < 1e-9 {
        return None;
    }
    let s = vec3::add(
        vec3::add(vec3::scale(x12, c[0]), vec3::scale(vec3::cross(n[2], n[0]), c[1])),
        vec3::scale(vec3::cross(n[0], n[1]), c[2]),
    );
    Some(vec3::scale(s, 1.0 / det))
}

fn sphere_corner(faces: &Faces<'_>, v: V3, edges: &[Geom], radius: f64, tolerance: f64) -> Result<TriMesh> {
    let fail = || {
        Error::invalid(
            "edges",
            format!(
                "the corner at ({:.3}, {:.3}, {:.3}) joins three fillets this tool cannot blend; leave one of its edges out or make it a chamfer",
                v[0], v[1], v[2]
            ),
        )
    };
    let convex = edges[0].convex;
    if edges.iter().any(|g| g.convex != convex) {
        return Err(fail());
    }
    let mut regs: Vec<usize> = edges.iter().flat_map(|g| [g.ra, g.rb]).collect();
    regs.sort_unstable();
    regs.dedup();
    if regs.len() != 3 {
        return Err(fail());
    }
    let n = [0, 1, 2].map(|i| faces.regions[regs[i]].normal);
    for i in 0..3 {
        if vec3::dot(n[i], n[(i + 1) % 3]) < -1e-6 {
            return Err(fail());
        }
    }
    let base = n.map(|ni| vec3::dot(ni, v));
    let (lo, hi) = if convex {
        (-radius, MARGIN_MM)
    } else {
        (-MARGIN_MM, radius)
    };
    let center_off = if convex { -radius } else { radius };
    let center = solve3(n, base.map(|b| b + center_off)).ok_or_else(fail)?;
    let mut block = build::box_mesh([0.0; 3], [1.0; 3]);
    for p in &mut block.positions {
        let c = [0, 1, 2].map(|i| base[i] + if p[i] > 0.5 { hi } else { lo });
        *p = solve3(n, c).ok_or_else(fail)?;
    }
    if block.volume() < 0.0 {
        block.flip();
    }
    let step = (1.0 - (tolerance / radius).min(1.0)).m_acos();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "clamped")]
    let segs = if step > 0.0 {
        ((PI / step).ceil() as usize).clamp(16, 256).next_multiple_of(4)
    } else {
        256
    };
    let ball = build::uv_sphere(center, radius, segs / 2, segs);
    let (out, r) = boolean::boolean(&[block], &[ball], BoolOp::Difference, &BooleanOptions::default())?;
    if r.empty || !r.watertight {
        return Err(fail());
    }
    Ok(out)
}

fn fit_error(what: &'static str, v: f64, max: f64) -> Error {
    Error::invalid(
        what,
        format!("{v} mm does not fit on this face; at most {:.3} mm", max.max(0.0)),
    )
}

fn overlap(a: &[V2], b: &[V2], eps: f64) -> bool {
    for poly in [a, b] {
        for i in 0..poly.len() {
            let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
            let axis = [q[1] - p[1], p[0] - q[0]];
            let proj = |s: &[V2]| {
                s.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
                    let x = axis[0] * v[0] + axis[1] * v[1];
                    (lo.min(x), hi.max(x))
                })
            };
            let (l0, h0) = proj(a);
            let (l1, h1) = proj(b);
            let scale = axis[0].m_hypot(axis[1]).max(1e-300);
            if h0 <= l1 + eps * scale || h1 <= l0 + eps * scale {
                return false;
            }
        }
    }
    true
}

#[allow(clippy::too_many_lines, reason = "checks, pieces and corners in one pass")]
fn tools(mesh: &TriMesh, edges: &[EdgeRef], profile: Profile) -> Result<Tools> {
    mesh.validate("mesh")?;
    let profile = check_profile(profile)?;
    if edges.is_empty() {
        return Err(Error::invalid("edges", "pick at least one edge"));
    }
    let faces = Faces::new(mesh);
    // A straight edge with its faces' keys is found between those faces first, then by place as before.
    let mut notes = Vec::new();
    let found: Vec<EdgeRef> = edges
        .iter()
        .enumerate()
        .map(|(i, e)| match relocate(mesh, e) {
            Some((r, split)) => {
                if split {
                    notes.push(format!(
                        "edge {} was split in two; rounded its longer part",
                        i + 1
                    ));
                }
                r
            }
            None => keyed(mesh, e),
        })
        .collect();
    let edges = found.as_slice();
    // Round edges get their own tools; the straight ones go on as before, numbered as the request numbers them.
    let mut rims = Vec::new();
    let mut straight = Vec::new();
    for (i, e) in edges.iter().enumerate() {
        if e.center.is_some() {
            rims.push((i + 1, rim::of_ref(mesh, e, i + 1)?));
        } else {
            straight.push((i + 1, e));
        }
    }
    let geoms = straight
        .iter()
        .map(|&(n, e)| resolve(&faces, n, e))
        .collect::<Result<Vec<_>>>()?;
    let mut strips: Vec<(usize, usize, [V3; 4])> = Vec::new();
    for (i, g) in geoms.iter().enumerate() {
        let widths = match profile {
            Profile::Chamfer { d1, d2 } => [d1, d2],
            Profile::Fillet { radius, .. } => [setback(g, radius); 2],
        };
        for (side, &w) in widths.iter().enumerate() {
            if !fits(&faces, g, side, w) {
                let max = max_width(&faces, g, side);
                return Err(match profile {
                    Profile::Chamfer { d1, d2 } => {
                        if side == 1 && (d2 - d1).abs() > 0.0 {
                            fit_error("distance2Mm", d2, max)
                        } else if side == 1 {
                            fit_error("distanceMm", d1, max.min(max_width(&faces, g, 0)))
                        } else {
                            let m2 = if (d2 - d1).abs() > 0.0 {
                                max
                            } else {
                                max.min(max_width(&faces, g, 1))
                            };
                            fit_error("distanceMm", d1, m2)
                        }
                    }
                    Profile::Fillet { radius, .. } => {
                        let w = max_width(&faces, g, 0).min(max_width(&faces, g, 1));
                        fit_error("radiusMm", radius, w * (g.phi * 0.5).m_tan())
                    }
                });
            }
            let r = if side == 0 { g.ra } else { g.rb };
            if let Some(q) = g.strip(side, w) {
                strips.push((i, r, q));
            }
        }
    }
    let eps = faces.tol() * 10.0;
    let ends_of = |i: usize| [key(geoms[i].a), key(geoms[i].b)];
    for (x, &(i, ri, qi)) in strips.iter().enumerate() {
        for &(j, rj, qj) in &strips[x + 1..] {
            if i == j || ri != rj || ends_of(i).iter().any(|k| ends_of(j).contains(k)) {
                continue;
            }
            let f = &faces.regions[ri];
            let Some(frame) = Frame::from_normal(f.point, f.normal, None) else {
                continue;
            };
            let a: Vec<V2> = qi.iter().map(|&p| frame.project(p)).collect();
            let b: Vec<V2> = qj.iter().map(|&p| frame.project(p)).collect();
            if overlap(&a, &b, eps) {
                let (what, v) = match profile {
                    Profile::Chamfer { d1, .. } => ("distanceMm", d1),
                    Profile::Fillet { radius, .. } => ("radiusMm", radius),
                };
                return Err(Error::invalid(
                    what,
                    format!(
                        "{v} mm does not fit; edges {} and {} would overlap on one face",
                        i + 1,
                        j + 1
                    ),
                ));
            }
        }
    }
    let mut out = Tools {
        refs: found.clone(),
        notes: std::mem::take(&mut notes),
        ..Tools::default()
    };
    for &(n, ref r) in &rims {
        let widths = r.widths(profile);
        for (side, &w) in widths.iter().enumerate() {
            if w > r.room[side] + 1e-9 {
                let max = (r.room[side] * 1000.0 + 1e-6).floor() / 1000.0;
                return Err(match profile {
                    Profile::Chamfer { d1, d2 } if side == 1 && (d2 - d1).abs() > 0.0 => {
                        fit_error("distance2Mm", d2, max)
                    }
                    Profile::Chamfer { d1, .. } => fit_error("distanceMm", d1, max),
                    Profile::Fillet { radius, .. } => {
                        let w = r.room[0].min(r.room[1]);
                        fit_error(
                            "radiusMm",
                            radius,
                            (w * (r.geom().phi * 0.5).m_tan() * 1000.0 + 1e-6).floor() / 1000.0,
                        )
                    }
                });
            }
        }
        let m = r.tool(profile, n)?;
        if r.convex {
            out.cut.push(m);
        } else {
            out.join.push(m);
        }
        out.edges.push(EdgeInfo {
            convex: r.convex,
            dihedral_deg: r.dihedral_deg(),
            length_mm: r.length(),
        });
    }
    for (i, g) in geoms.iter().enumerate() {
        let m = piece(g, profile, straight[i].0)?;
        if g.convex {
            out.cut.push(m);
        } else {
            out.join.push(m);
        }
        out.edges.push(EdgeInfo {
            convex: g.convex,
            dihedral_deg: g.dihedral_deg(),
            length_mm: g.len,
        });
    }
    if let Profile::Fillet { radius, tolerance } = profile {
        let mut at: HashMap<Key, (V3, Vec<usize>)> = HashMap::new();
        for (i, g) in geoms.iter().enumerate() {
            for p in [g.a, g.b] {
                at.entry(key(p)).or_insert((p, Vec::new())).1.push(i);
            }
        }
        let mut corners: Vec<(V3, Vec<usize>)> = at.into_values().filter(|(_, l)| l.len() >= 3).collect();
        corners.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        for (v, list) in corners {
            let gs: Vec<Geom> = list.iter().map(|&i| geoms[i]).collect();
            if gs.len() != 3 {
                return Err(Error::invalid(
                    "edges",
                    format!(
                        "the corner at ({:.3}, {:.3}, {:.3}) joins more than three fillets; leave some of its edges out",
                        v[0], v[1], v[2]
                    ),
                ));
            }
            let m = sphere_corner(&faces, v, &gs, radius, tolerance)?;
            if gs[0].convex {
                out.cut.push(m);
            } else {
                out.join.push(m);
            }
            out.corners.push(Corner {
                at: v,
                kind: "sphere",
            });
        }
    }
    Ok(out)
}

/// The two faces' keys at the middle of edge `e`, the face `e.face` faces first, or none when the mesh's faces have
/// no keys there.
fn keys_at(mesh: &TriMesh, e: &EdgeRef) -> Option<[u64; 2]> {
    let f = mesh.faces.as_ref().filter(|f| !f.keys.is_empty())?;
    let mid = vec3::scale(vec3::add(e.a, e.b), 0.5);
    let face = vec3::normalize(e.face)?;
    let size = mesh.bounds().map_or(1.0, |b| b.diagonal());
    let tol = REF_MM.max(size * 1e-7);
    let mut sides: Vec<(u64, f64)> = Vec::new();
    for (t, tri) in mesh.triangles.iter().enumerate() {
        let c = tri.map(|v| mesh.positions[v as usize]);
        let on = (0..3).any(|j| dist_to_segment(mid, c[j], c[(j + 1) % 3]) < tol);
        if !on {
            continue;
        }
        let k = f.keys.get(f.ids[t] as usize).copied().unwrap_or(0);
        let n = vec3::normalize(mesh.normal(*tri)).unwrap_or([0.0; 3]);
        if k != 0 && !sides.iter().any(|(x, _)| *x == k) {
            sides.push((k, vec3::dot(n, face)));
        }
    }
    if sides.len() != 2 {
        return None;
    }
    sides.sort_by(|a, b| b.1.total_cmp(&a.1));
    Some([sides[0].0, sides[1].0])
}

/// The reference with its faces' keys added when it has none and the mesh has them.
pub fn keyed(mesh: &TriMesh, e: &EdgeRef) -> EdgeRef {
    if e.keys.is_some() {
        return *e;
    }
    EdgeRef {
        keys: keys_at(mesh, e),
        ..*e
    }
}

/// The vertex a run of edges is known by (a union find without ranks).
fn run_root(p: &mut HashMap<u32, u32>, v: u32) -> u32 {
    let mut r = v;
    while let Some(&q) = p.get(&r) {
        if q == r {
            break;
        }
        r = q;
    }
    r
}

/// A straight edge found again between the faces with its keys: its ends as the mesh has them now, and whether the
/// boundary between those faces came apart (then its longest run). None when it has no keys or the faces no longer
/// meet.
fn relocate(mesh: &TriMesh, e: &EdgeRef) -> Option<(EdgeRef, bool)> {
    let [k0, k1] = e.keys?;
    if e.center.is_some() {
        return None;
    }
    let f = mesh.faces.as_ref().filter(|f| !f.keys.is_empty())?;
    let key = |t: usize| f.keys.get(f.ids[t] as usize).copied().unwrap_or(0);
    let mut by_edge: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (t, tri) in mesh.triangles.iter().enumerate() {
        for j in 0..3 {
            let (u, v) = (tri[j], tri[(j + 1) % 3]);
            by_edge.entry((u.min(v), u.max(v))).or_default().push(t);
        }
    }
    let segs: Vec<(u32, u32)> = by_edge
        .iter()
        .filter(|(_, ts)| {
            let [t0, t1] = ts[..] else { return false };
            let (a, b) = (key(t0), key(t1));
            (a == k0 && b == k1) || (a == k1 && b == k0)
        })
        .map(|(&uv, _)| uv)
        .collect();
    if segs.is_empty() {
        return None;
    }
    // Runs: segments joined through shared vertices.
    let mut parent: HashMap<u32, u32> = HashMap::new();
    for &(u, v) in &segs {
        parent.entry(u).or_insert(u);
        parent.entry(v).or_insert(v);
        let (ru, rv) = (run_root(&mut parent, u), run_root(&mut parent, v));
        parent.insert(ru, rv);
    }
    let mut runs: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
    for &(u, v) in &segs {
        let r = run_root(&mut parent, u);
        runs.entry(r).or_default().push((u, v));
    }
    let span = |run: &[(u32, u32)]| -> Option<(V3, V3, f64)> {
        let (u, v) = *run.first()?;
        let (p, q) = (mesh.positions[u as usize], mesh.positions[v as usize]);
        let d = vec3::normalize(vec3::sub(q, p))?;
        let pts = run
            .iter()
            .flat_map(|&(u, v)| [mesh.positions[u as usize], mesh.positions[v as usize]]);
        let (mut lo, mut hi) = ((f64::INFINITY, p), (f64::NEG_INFINITY, p));
        for x in pts {
            let t = vec3::dot(vec3::sub(x, p), d);
            if t < lo.0 {
                lo = (t, x);
            }
            if t > hi.0 {
                hi = (t, x);
            }
        }
        Some((lo.1, hi.1, hi.0 - lo.0))
    };
    let spans: Vec<(V3, V3, f64)> = runs.values().filter_map(|r| span(r)).collect();
    let &(a, b, _) = spans.iter().max_by(|x, y| x.2.total_cmp(&y.2))?;
    // The normal of the face `face` faced, as it is now.
    let t0 = mesh.triangles.iter().enumerate().find(|&(t, _)| key(t) == k0)?.1;
    let face = vec3::normalize(mesh.normal(*t0))?;
    // Keep the ends in the order the reference had them.
    let (a, b) = if vec3::dot(vec3::sub(b, a), vec3::sub(e.b, e.a)) < 0.0 {
        (b, a)
    } else {
        (a, b)
    };
    Some((
        EdgeRef {
            a,
            b,
            face,
            moved: false,
            center: None,
            keys: e.keys,
        },
        spans.len() > 1,
    ))
}

pub fn apply(
    mesh: &TriMesh,
    edges: &[EdgeRef],
    profile: Profile,
    opts: &BooleanOptions,
) -> Result<EdgeResult> {
    let t = tools(mesh, edges, profile)?;
    let mut solid = Solid::new(mesh)?;
    let v0 = solid.volume();
    let mut last = None;
    if !t.join.is_empty() {
        let adds = t.join.iter().map(Solid::new).collect::<Result<Vec<_>>>()?;
        let (m, r) = boolean::boolean_solids(&[solid], &adds, BoolOp::Union, opts)?;
        solid = Solid::new(&m)?;
        last = Some((m, r));
    }
    if !t.cut.is_empty() {
        let cuts = t.cut.iter().map(Solid::new).collect::<Result<Vec<_>>>()?;
        last = Some(boolean::boolean_solids(
            &[solid],
            &cuts,
            BoolOp::Difference,
            opts,
        )?);
    }
    let Some((out, r)) = last else {
        return Err(Error::invalid("edges", "pick at least one edge"));
    };
    if r.empty || out.triangles.is_empty() {
        return Err(Error::geometry("edges", "the change removes the whole body"));
    }
    if !r.watertight {
        return Err(Error::geometry(
            "edges",
            "the result is not watertight; try a smaller size",
        ));
    }
    Ok(EdgeResult {
        report: EdgeReport {
            volume_change_mm3: r.volume_mm3 - v0,
            shells: r.shells,
            watertight: r.watertight,
            boolean: r,
        },
        mesh: out,
        edges: t.edges,
        corners: t.corners,
        refs: t.refs,
        notes: t.notes,
    })
}

pub fn preview(mesh: &TriMesh, edges: &[EdgeRef], profile: Profile) -> Result<(TriMesh, TriMesh)> {
    let t = tools(mesh, edges, profile)?;
    let mut cut = TriMesh::default();
    for m in &t.cut {
        cut.append(m);
    }
    let mut join = TriMesh::default();
    for m in &t.join {
        join.append(m);
    }
    Ok((cut, join))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tri_facing(m: &TriMesh, dir: V3, near: V3) -> u32 {
        let mut best = (f64::INFINITY, 0usize);
        for (i, &t) in m.triangles.iter().enumerate() {
            let n = vec3::normalize(m.normal(t)).unwrap_or([0.0; 3]);
            if vec3::dot(n, dir) < 0.999 {
                continue;
            }
            let c = m.corners(t);
            let d = vec3::len(vec3::sub(centroid(c), near));
            if d < best.0 {
                best = (d, i);
            }
        }
        u32::try_from(best.1).unwrap()
    }

    fn pick(m: &TriMesh, dir: V3, at: V3) -> EdgePick {
        pick_edge(m, tri_facing(m, dir, at), at).unwrap()
    }

    fn chamfer(d: f64) -> Profile {
        Profile::Chamfer { d1: d, d2: d }
    }

    fn fillet(r: f64) -> Profile {
        Profile::Fillet {
            radius: r,
            tolerance: DEFAULT_TOLERANCE_MM,
        }
    }

    fn run(m: &TriMesh, edges: &[EdgeRef], p: Profile) -> Result<EdgeResult> {
        apply(m, edges, p, &BooleanOptions::default())
    }

    fn sound(r: &EdgeResult) {
        assert!(r.report.watertight, "not watertight");
        assert_eq!(r.report.shells, 1);
        let e = r.mesh.edge_report();
        assert!(e.is_watertight(), "{e:?}");
    }

    fn e(a: V3, b: V3, face: V3) -> EdgeRef {
        EdgeRef {
            a,
            b,
            face,
            moved: false,
            center: None,
            keys: None,
        }
    }

    fn top_loop(x: f64, y: f64, z: f64) -> Vec<EdgeRef> {
        let up = [0.0, 0.0, 1.0];
        vec![
            e([0.0, 0.0, z], [x, 0.0, z], up),
            e([x, 0.0, z], [x, y, z], up),
            e([x, y, z], [0.0, y, z], up),
            e([0.0, y, z], [0.0, 0.0, z], up),
        ]
    }

    fn l_bracket() -> TriMesh {
        let a = build::box_mesh([0.0; 3], [30.0, 20.0, 4.0]);
        let b = build::box_mesh([0.0, 0.0, 0.0], [4.0, 20.0, 25.0]);
        boolean::boolean(&[a], &[b], BoolOp::Union, &BooleanOptions::default())
            .unwrap()
            .0
    }

    #[test]
    fn pick_a_box_edge() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let p = pick(&m, [0.0, 0.0, 1.0], [8.0, 0.4, 5.0]);
        assert!(p.supported, "{:?}", p.reason);
        assert!(p.convex);
        assert!((p.dihedral_deg - 90.0).abs() < 1e-9);
        assert!((p.length_mm - 20.0).abs() < 1e-9);
        assert_eq!(p.faces.len(), 2);
        assert!((p.faces[1].normal[1] + 1.0).abs() < 1e-9);
        assert!(
            (p.max_distance_mm[0] - 10.0).abs() < 1e-6,
            "{:?}",
            p.max_distance_mm
        );
        assert!((p.max_distance_mm[1] - 5.0).abs() < 1e-6);
        assert!((p.max_radius_mm - 5.0).abs() < 1e-6);
        assert_eq!(p.ring.len(), 4);
        assert!(p.ring.iter().all(|l| l.supported));
        assert_eq!(p.chain.len(), 1);
        assert_eq!(p.ring[0].edge, p.edge);
    }

    /// A 40 by 30 by 20 box with keys, and a 6 mm slot across it from z 10 up, starting at `x`: two requests, as the
    /// worker runs them.
    fn slotted(x: f64) -> TriMesh {
        let mut b = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        crate::faces::with_key_salt(Some(1), || crate::faces::base_keys(&mut b));
        let slot = build::box_mesh([x, -1.0, 10.0], [x + 6.0, 31.0, 21.0]);
        crate::faces::with_key_salt(Some(2), || {
            boolean::boolean(&[b], &[slot], BoolOp::Difference, &BooleanOptions::default())
                .unwrap()
                .0
        })
    }

    #[test]
    fn an_edge_is_found_by_its_faces_keys_after_it_moved() {
        let m = slotted(20.0);
        // The edge where the top meets the slot's near wall.
        let e = keyed(&m, &pick(&m, [0.0, 0.0, 1.0], [19.9, 15.0, 20.0]).edge);
        assert!(e.keys.is_some());
        assert!((e.a[0] - 20.0).abs() < 1e-9 && (e.b[0] - 20.0).abs() < 1e-9);
        // The slot moved 5 mm: the edge is found by its faces, its old place is empty.
        let moved = slotted(25.0);
        let r = apply(&moved, &[e], chamfer(1.0), &BooleanOptions::default()).unwrap();
        assert!(r.report.watertight && r.notes.is_empty());
        assert!(
            (r.report.volume_change_mm3 + 15.0).abs() < 1e-6,
            "{}",
            r.report.volume_change_mm3
        );
        assert!((r.refs[0].a[0] - 25.0).abs() < 1e-9 && r.refs[0].keys == e.keys);
        let by_place = EdgeRef { keys: None, ..e };
        let err = apply(&moved, &[by_place], chamfer(1.0), &BooleanOptions::default()).unwrap_err();
        assert!(err.to_string().contains("no sharp edge"), "{err}");
    }

    #[test]
    fn an_edge_split_in_two_is_found_by_its_longer_run_and_says_so() {
        let mut b = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        crate::faces::with_key_salt(Some(1), || crate::faces::base_keys(&mut b));
        // The top front edge, picked before a notch cut it in two.
        let e = keyed(&b, &pick(&b, [0.0, 0.0, 1.0], [20.0, 0.1, 20.0]).edge);
        assert!(e.keys.is_some());
        let notch = build::box_mesh([10.0, -1.0, 10.0], [14.0, 5.0, 21.0]);
        let m = crate::faces::with_key_salt(Some(2), || {
            boolean::boolean(&[b], &[notch], BoolOp::Difference, &BooleanOptions::default())
                .unwrap()
                .0
        });
        let r = apply(&m, &[e], chamfer(1.0), &BooleanOptions::default()).unwrap();
        assert!(r.notes[0].contains("split in two"), "{:?}", r.notes);
        let (lo, hi) = (
            r.refs[0].a[0].min(r.refs[0].b[0]),
            r.refs[0].a[0].max(r.refs[0].b[0]),
        );
        assert!((lo - 14.0).abs() < 1e-9 && (hi - 40.0).abs() < 1e-9, "{lo} {hi}");
        assert!(
            (r.report.volume_change_mm3 + 13.0).abs() < 1e-6,
            "{}",
            r.report.volume_change_mm3
        );
    }

    #[test]
    fn a_reference_without_keys_gets_them_from_the_mesh_and_works_by_place() {
        let m = slotted(20.0);
        let e = pick(&m, [0.0, 0.0, 1.0], [19.9, 15.0, 20.0]).edge;
        let r = apply(
            &m,
            &[EdgeRef { keys: None, ..e }],
            chamfer(1.0),
            &BooleanOptions::default(),
        )
        .unwrap();
        assert!(r.refs[0].keys.is_some() && r.notes.is_empty());
    }

    #[test]
    fn chamfer_one_edge_and_two_distances() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let edge = pick(&m, [0.0, 0.0, 1.0], [8.0, 0.4, 5.0]).edge;
        let r = run(&m, &[edge], chamfer(2.0)).unwrap();
        sound(&r);
        assert!(
            (r.mesh.volume() - (1000.0 - 40.0)).abs() < 1e-6,
            "{}",
            r.mesh.volume()
        );
        assert!((r.report.volume_change_mm3 + 40.0).abs() < 1e-6);
        let r = run(&m, &[edge], Profile::Chamfer { d1: 3.0, d2: 1.0 }).unwrap();
        sound(&r);
        assert!((r.mesh.volume() - (1000.0 - 30.0)).abs() < 1e-6);
        let b = r.mesh.bounds().unwrap();
        assert!((b.max[2] - 5.0).abs() < 1e-9);
        let top_min_y = r
            .mesh
            .positions
            .iter()
            .filter(|p| (p[2] - 5.0).abs() < 1e-9)
            .map(|p| p[1])
            .fold(f64::INFINITY, f64::min);
        assert!((top_min_y - 3.0).abs() < 1e-9, "{top_min_y}");
    }

    #[test]
    fn fillet_one_edge_and_a_loop() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let edge = pick(&m, [0.0, 0.0, 1.0], [8.0, 0.4, 5.0]).edge;
        let r = run(&m, &[edge], fillet(2.0)).unwrap();
        sound(&r);
        // chords sit inside the arc, so a little more goes than the exact round (0.01 mm tolerance)
        let exact = 1000.0 - 20.0 * 4.0 * (1.0 - PI / 4.0);
        assert!(
            r.mesh.volume() < exact && exact - r.mesh.volume() < 0.5,
            "{} vs {exact}",
            r.mesh.volume()
        );
        let r = run(&m, &top_loop(20.0, 10.0, 5.0), fillet(2.0)).unwrap();
        sound(&r);
        assert!(r.corners.is_empty());
        let r = run(&m, &top_loop(20.0, 10.0, 5.0), chamfer(1.5)).unwrap();
        sound(&r);
    }

    #[test]
    fn a_face_beside_a_fillet_is_still_flat() {
        // round one top edge, then the opposite one: the top stays a flat face
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let first = pick(&m, [0.0, 0.0, 1.0], [8.0, 0.4, 5.0]).edge;
        let once = run(&m, &[first], fillet(2.0)).unwrap();
        let p = pick(&once.mesh, [0.0, 0.0, 1.0], [8.0, 9.6, 5.0]);
        assert!(p.supported, "{:?}", p.reason);
        let twice = run(&once.mesh, &[p.edge], chamfer(1.0)).unwrap();
        sound(&twice);
        assert!(
            (twice.report.volume_change_mm3 + 10.0).abs() < 1e-6,
            "{}",
            twice.report.volume_change_mm3
        );
    }

    #[test]
    fn rounded_cube_gets_sphere_corners() {
        let a = 20.0;
        let m = build::box_mesh([0.0; 3], [a; 3]);
        let mut edges = top_loop(a, a, a);
        let down = [0.0, 0.0, -1.0];
        edges.extend([
            e([0.0, 0.0, 0.0], [a, 0.0, 0.0], down),
            e([a, 0.0, 0.0], [a, a, 0.0], down),
            e([a, a, 0.0], [0.0, a, 0.0], down),
            e([0.0, a, 0.0], [0.0, 0.0, 0.0], down),
        ]);
        let front = [0.0, -1.0, 0.0];
        let back = [0.0, 1.0, 0.0];
        edges.extend([
            e([0.0, 0.0, 0.0], [0.0, 0.0, a], front),
            e([a, 0.0, 0.0], [a, 0.0, a], front),
            e([0.0, a, 0.0], [0.0, a, a], back),
            e([a, a, 0.0], [a, a, a], back),
        ]);
        let r0 = 3.0;
        let res = run(&m, &edges, fillet(r0)).unwrap();
        sound(&res);
        assert_eq!(res.corners.len(), 8);
        let k = a - 2.0 * r0;
        let exact = k * k * k + 6.0 * k * k * r0 + 3.0 * PI * r0 * r0 * k + 4.0 / 3.0 * PI * r0 * r0 * r0;
        let v = res.mesh.volume();
        assert!((v - exact).abs() / exact < 2e-3, "{v} vs {exact}");
    }

    #[test]
    fn concave_edge_gains_material() {
        let m = l_bracket();
        let p = pick(&m, [0.0, 0.0, 1.0], [5.0, 10.0, 4.0]);
        assert!(p.supported, "{:?}", p.reason);
        assert!(!p.convex);
        assert!((p.dihedral_deg - 270.0).abs() < 1e-9);
        let v0 = m.volume();
        let r = run(&m, &[p.edge], fillet(3.0)).unwrap();
        sound(&r);
        let gain = 20.0 * 9.0 * (1.0 - PI / 4.0);
        assert!(
            r.mesh.volume() - v0 > gain && r.mesh.volume() - v0 - gain < 0.7,
            "{}",
            r.mesh.volume() - v0
        );
        let r = run(&m, &[p.edge], chamfer(3.0)).unwrap();
        sound(&r);
        assert!((r.mesh.volume() - v0 - 90.0).abs() < 1e-6);
        let outer = pick(&m, [0.0, 0.0, 1.0], [2.0, 10.0, 25.0]);
        let r = run(&m, &[p.edge, outer.edge], fillet(1.5)).unwrap();
        sound(&r);
    }

    #[test]
    fn too_big_fails_in_words() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let edge = pick(&m, [0.0, 0.0, 1.0], [8.0, 0.4, 5.0]).edge;
        let err = run(&m, &[edge], fillet(6.0)).unwrap_err().to_string();
        assert_eq!(err, "radiusMm: 6 mm does not fit on this face; at most 5.000 mm");
        let err = run(&m, &[edge], Profile::Chamfer { d1: 2.0, d2: 7.0 })
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("distance2Mm: 7 mm does not fit"), "{err}");
        let bottom = e([0.0, 0.0, 0.0], [20.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
        let err = run(&m, &[edge, bottom], fillet(3.0)).unwrap_err().to_string();
        assert!(err.contains("would overlap"), "{err}");
        assert!(run(&m, &[edge, bottom], fillet(2.5)).is_ok());
        let err = run(&m, &[], fillet(1.0)).unwrap_err().to_string();
        assert_eq!(err, "edges: pick at least one edge");
        let err = run(&m, &[edge], fillet(0.0)).unwrap_err().to_string();
        assert_eq!(err, "radiusMm: must be above 0 (at most 1000 mm)");
        let gone = e([0.0, 3.0, 5.0], [20.0, 3.0, 5.0], [0.0, 0.0, 1.0]);
        let err = run(&m, &[gone], fillet(1.0)).unwrap_err().to_string();
        assert_eq!(err, "edges: edge 1: no sharp edge between two flat faces there");
    }

    #[test]
    fn moved_refs_are_found_along_their_line() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let up = [0.0, 0.0, 1.0];
        let exact = run(&m, &[e([0.0, 0.0, 5.0], [20.0, 0.0, 5.0], up)], fillet(2.0)).unwrap();
        let moved = |a: V3, b: V3| EdgeRef {
            moved: true,
            ..e(a, b, up)
        };
        // part of the edge, past its end, or the other way along it: the whole edge
        for (a, b) in [
            ([5.0, 0.0, 5.0], [12.0, 0.0, 5.0]),
            ([0.0, 0.0, 5.0], [25.0, 0.0, 5.0]),
            ([-3.0, 0.0, 5.0], [1.0, 0.0, 5.0]),
        ] {
            let r = run(&m, &[moved(a, b)], fillet(2.0)).unwrap();
            assert_eq!(r.mesh, exact.mesh);
            let err = run(&m, &[e(a, b, up)], fillet(2.0)).unwrap_err().to_string();
            assert_eq!(err, "edges: edge 1: no sharp edge between two flat faces there");
        }
        let back = run(&m, &[moved([20.0, 0.0, 5.0], [3.0, 0.0, 5.0])], fillet(2.0)).unwrap();
        sound(&back);
        assert!((back.mesh.volume() - exact.mesh.volume()).abs() < 1e-9);
        let off = run(&m, &[moved([0.0, 0.5, 5.0], [20.0, 0.5, 5.0])], fillet(2.0))
            .unwrap_err()
            .to_string();
        assert_eq!(
            off,
            "edges: edge 1 moved with the face beside it and is not there any more; pick it again"
        );
        let beyond = run(&m, &[moved([21.0, 0.0, 5.0], [30.0, 0.0, 5.0])], fillet(2.0));
        assert!(beyond.is_err());
        // a slot through the front leaves two edges on one line
        let slot = build::box_mesh([10.0, -1.0, -1.0], [14.0, 4.0, 6.0]);
        let notched = boolean::boolean(&[m], &[slot], BoolOp::Difference, &BooleanOptions::default())
            .unwrap()
            .0;
        let err = run(&notched, &[moved([5.0, 0.0, 5.0], [15.0, 0.0, 5.0])], fillet(1.0))
            .unwrap_err()
            .to_string();
        assert!(err.contains("more than one edge matches"), "{err}");
        let one = run(&notched, &[moved([1.0, 0.0, 5.0], [2.0, 0.0, 5.0])], fillet(1.0)).unwrap();
        sound(&one);
    }

    #[test]
    fn curved_neighbors_are_not_supported() {
        // A round plate's rim, where its top meets a cylinder square to it, is a round edge (`rim`).
        let f = Frame::WORLD;
        let plate = build::cylinder(&f, 10.0, 0.0, 5.0, 64);
        let p = pick(&plate, [0.0, 0.0, 1.0], [9.9, 0.0, 5.0]);
        assert!(
            p.supported && p.convex && p.edge.center.is_some(),
            "{:?}",
            p.reason
        );
        sound(&run(&plate, &[p.edge], fillet(1.0)).unwrap());
        // The rim of a cone's base is not: the face across it is curved and not a cylinder.
        let tri = vec![Polygon::simple(vec![[0.0, 0.0], [10.0, 0.0], [0.0, 5.0]])];
        let m = crate::sketch::revolve(&Frame::WORLD, &tri, [0.0, 0.0], [0.0, 1.0], 360.0).unwrap();
        let m = crate::xform::transformed(
            &m,
            &crate::xform::rotation_about([0.0; 3], [1.0, 0.0, 0.0], PI / 2.0),
        );
        let p = pick(&m, [0.0, 0.0, -1.0], [9.9, 0.0, 0.0]);
        assert!(!p.supported);
        assert_eq!(
            p.reason.as_deref(),
            Some("The face across the edge is curved. Fillet and chamfer work between flat faces only.")
        );
        let err = run(&m, &[p.edge], fillet(1.0)).unwrap_err().to_string();
        assert!(err.contains("curved"), "{err}");
    }

    #[test]
    fn mixed_three_way_corner_fails_in_words() {
        let m = l_bracket();
        let inner = e([4.0, 0.0, 4.0], [4.0, 20.0, 4.0], [0.0, 0.0, 1.0]);
        let side = [0.0, -1.0, 0.0];
        let a = e([4.0, 0.0, 4.0], [30.0, 0.0, 4.0], side);
        let b = e([4.0, 0.0, 4.0], [4.0, 0.0, 25.0], side);
        let err = run(&m, &[inner, a, b], fillet(1.0)).unwrap_err().to_string();
        assert!(err.contains("cannot blend"), "{err}");
        let r = run(&m, &[inner, a, b], chamfer(1.0)).unwrap();
        sound(&r);
    }

    #[test]
    fn preview_has_pieces_without_boolean() {
        let m = l_bracket();
        let inner = e([4.0, 0.0, 4.0], [4.0, 20.0, 4.0], [0.0, 0.0, 1.0]);
        let outer = e([0.0, 0.0, 25.0], [0.0, 20.0, 25.0], [0.0, 0.0, 1.0]);
        let (cut, join) = preview(&m, &[inner, outer], fillet(2.0)).unwrap();
        assert!(!cut.triangles.is_empty() && !join.triangles.is_empty());
        assert!(cut.edge_report().is_watertight() && join.edge_report().is_watertight());
    }

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.next()
        }
    }

    fn wedge(x: f64, y: f64, z: f64) -> TriMesh {
        let poly = Polygon::simple(vec![[0.0, 0.0], [y, 0.0], [0.0, z]]);
        let f = Frame {
            origin: [0.0; 3],
            u: [0.0, 1.0, 0.0],
            v: [0.0, 0.0, 1.0],
            w: [1.0, 0.0, 0.0],
        };
        build::extrude(&[poly], &f, 0.0, x).unwrap()
    }

    #[test]
    fn random_shapes_never_break() {
        let mut g = Lcg(7);
        let mut ok = 0;
        let mut refused = 0;
        for round in 0..36 {
            let (x, y, z) = (g.range(5.0, 30.0), g.range(5.0, 30.0), g.range(3.0, 20.0));
            let m = match round % 3 {
                0 => build::box_mesh([0.0; 3], [x, y, z]),
                1 => wedge(x, y, z),
                _ => {
                    let t = g.range(1.0, x.min(z) * 0.6);
                    let a = build::box_mesh([0.0; 3], [x, y, t]);
                    let b = build::box_mesh([0.0; 3], [t, y, z]);
                    boolean::boolean(&[a], &[b], BoolOp::Union, &BooleanOptions::default())
                        .unwrap()
                        .0
                }
            };
            let mut picked = Vec::new();
            for _ in 0..3 {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let t = ((g.next() * m.triangles.len() as f64) as usize).min(m.triangles.len() - 1);
                let c = m.corners(m.triangles[t]);
                let w = [g.next(), g.next(), g.next()];
                let s = w[0] + w[1] + w[2];
                let at = vec3::add(
                    vec3::add(vec3::scale(c[0], w[0] / s), vec3::scale(c[1], w[1] / s)),
                    vec3::scale(c[2], w[2] / s),
                );
                let p = pick_edge(&m, u32::try_from(t).unwrap(), at).unwrap();
                if p.supported && !picked.contains(&p.edge) {
                    picked.push(p.edge);
                }
            }
            if picked.is_empty() {
                continue;
            }
            let size = g.range(0.2, 25.0);
            let profile = if round % 2 == 0 {
                fillet(size)
            } else {
                chamfer(size)
            };
            match run(&m, &picked, profile) {
                Ok(r) => {
                    sound(&r);
                    ok += 1;
                }
                Err(e) => {
                    let s = e.to_string();
                    assert!(
                        s.contains("does not fit")
                            || s.contains("cannot blend")
                            || s.contains("more than three")
                            || s.contains("too short"),
                        "{s}"
                    );
                    refused += 1;
                }
            }
        }
        assert!(ok >= 5 && refused >= 3, "ok {ok} refused {refused}");
    }
}
