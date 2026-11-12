// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! fillet and chamfer on the straight edges where a flat face meets another face, and on the round edge where a
//! flat face meets a cylinder square to it (`rim`)
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
/// angles between faces this close, radians, are the same angle along a round
const SAME_RAD: f64 = 1e-4;

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
    /// the largest sizes the ops take on the whole chain: the least over its edges
    pub chain_max_distance_mm: [f64; 2],
    pub chain_max_radius_mm: f64,
    /// the same over every edge of the loop it can take
    pub loop_max_distance_mm: [f64; 2],
    pub loop_max_radius_mm: f64,
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

/// An edge a call left as it was, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    /// its place in the request, from 0
    pub index: usize,
    /// one of `not_found`, `face_reference`, `unsupported`, `does_not_fit`, `overlap`, `round_join`, `corner`
    pub code: &'static str,
    pub message: String,
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
    /// the edges left as they were, when the call may leave some
    pub skipped: Vec<Skipped>,
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
    /// boundaries asked for so far: a loop's ends each look along the same face
    seen: std::cell::RefCell<HashMap<usize, std::rc::Rc<Vec<Run>>>>,
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
            seen: std::cell::RefCell::default(),
        }
    }

    fn boundary_of(&self, r: usize) -> std::rc::Rc<Vec<Run>> {
        let mut seen = self.seen.borrow_mut();
        seen.entry(r)
            .or_insert_with(|| std::rc::Rc::new(self.boundary(r)))
            .clone()
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
        let edges = self.boundary_of(r);
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
    /// the flat face the edge shares with the round it runs on into, when the end is the plane halfway between them
    runs_on: Option<usize>,
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

    fn flipped(self) -> Self {
        Self {
            a: self.b,
            b: self.a,
            d: vec3::scale(self.d, -1.0),
            ends: [self.ends[1], self.ends[0]],
            ..self
        }
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

/// whether two faces meet at a sharp fold: what the pick, its loop and chain, and the ops all go by
fn sharp(faces: &Faces<'_>, ra: usize, rb: usize) -> bool {
    vec3::dot(faces.regions[ra].normal, faces.regions[rb].normal) < SHARP_DEG.to_radians().m_cos()
}

/// an edge as the pick and the ops both read it: a sharp fold, then its geometry
fn edge_geom(
    faces: &Faces<'_>,
    ra: usize,
    rb: usize,
    a: V3,
    b: V3,
    tri_a: u32,
    tri_b: u32,
) -> std::result::Result<Geom, String> {
    if !sharp(faces, ra, rb) {
        return Err("The faces along this edge meet at less than 30 degrees, too flat to round.".into());
    }
    geom(faces, ra, rb, a, b, tri_a, tri_b)
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
    if fa.curved && fb.curved {
        return Err(
            "Both faces along this edge are curved. Fillet and chamfer need a flat face on one side.".into(),
        );
    }
    if fa.curved {
        return Err("The picked face is curved. Pick the edge from the flat face on its other side.".into());
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
        runs_on: None,
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
        let out = if i == 0 { vec3::scale(d, -1.0) } else { d };
        if fb.curved || fc.curved {
            match round_end(faces, [ra, rb], c, p, out, (phi, convex)) {
                Some(end) => {
                    ends[i] = end?;
                    continue;
                }
                None if fc.curved => {
                    return Err("The edge ends at a curved face it does not run into smoothly.".into());
                }
                None => {}
            }
        }
        let along = vec3::dot(out, fc.normal);
        if along.abs() < 0.05 {
            return Err("The edge meets the face at its end at too shallow an angle.".into());
        }
        ends[i] = End {
            point: p,
            normal: fc.normal,
            extend: if convex { along > 0.0 } else { along < 0.0 },
            runs_on: None,
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

/// The plane halfway into the round `c` that the edge runs on into along one of its flat faces, or none.
fn round_end(
    faces: &Faces<'_>,
    own: [usize; 2],
    c: usize,
    p: V3,
    out: V3,
    (phi, convex): (f64, bool),
) -> Option<std::result::Result<End, String>> {
    let turn = SHARP_DEG.to_radians().m_cos();
    for s in own {
        if faces.regions[s].curved {
            continue;
        }
        let Some((run, tc)) = faces.boundary_of(s).iter().find_map(|r| match r.across {
            Across::Face(x, t) if x == c && (key(r.a) == key(p) || key(r.b) == key(p)) => Some((*r, t)),
            _ => None,
        }) else {
            continue;
        };
        let q = if key(run.a) == key(p) { run.b } else { run.a };
        let Some(next) = vec3::normalize(vec3::sub(q, p)) else {
            continue;
        };
        if vec3::dot(out, next) < turn {
            continue;
        }
        let (ns, nc) = (faces.regions[s].normal, faces.regions[c].normal);
        let (Some(ts), Some(tn)) = (
            inward(faces, ns, next, p, run.tri),
            inward(faces, nc, next, p, tc),
        ) else {
            continue;
        };
        // only with the same angle on both sides does the halfway plane hold the line between the faces across
        let phi_next = vec3::dot(ts, tn).clamp(-1.0, 1.0).m_acos();
        if (vec3::dot(ns, tn) < 0.0) != convex || (phi_next - phi).abs() > SAME_RAD {
            return Some(Err(
                "The angle between the faces changes along the round the edge runs into.".into(),
            ));
        }
        let normal = vec3::normalize(vec3::add(out, next))?;
        return Some(Ok(End {
            point: p,
            normal,
            extend: false,
            runs_on: Some(s),
        }));
    }
    None
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
    for e in faces.boundary_of(r).iter() {
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
            let fold = match run.across {
                Across::Face(rb, _) => sharp(&faces, r, rb),
                _ => true,
            };
            if !fold {
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
            chain_max_distance_mm: room,
            chain_max_radius_mm: floor((room[0].min(room[1]) * (rim.geom().phi * 0.5).m_tan()).min(MAX_MM)),
            loop_max_distance_mm: room,
            loop_max_radius_mm: floor((room[0].min(room[1]) * (rim.geom().phi * 0.5).m_tan()).min(MAX_MM)),
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
        chain_max_distance_mm: [0.0; 2],
        chain_max_radius_mm: 0.0,
        loop_max_distance_mm: [0.0; 2],
        loop_max_radius_mm: 0.0,
        chain: vec![edge],
        ring: Vec::new(),
    };
    // every side of an ellipse's rim is refused, so its loop shows no size
    let rim = !faces.regions[r].curved && ellipse_rim(&faces, r, ring);
    let geom_of = |run: &Run| -> std::result::Result<Geom, String> {
        if rim {
            return Err(ELLIPSE_RIM.into());
        }
        match run.across {
            Across::Face(rb, tb) => edge_geom(&faces, r, rb, run.a, run.b, run.tri, tb),
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
    if out.supported {
        // the same fit the ops make, edge by edge: a set takes no more than its tightest edge
        let floor = |w: f64| (w * 1000.0 + 1e-6).floor() / 1000.0;
        let room = |run: &Run| -> Option<([f64; 2], f64)> {
            let g = geom_of(run).ok()?;
            let w = [floor(max_width(&faces, &g, 0)), floor(max_width(&faces, &g, 1))];
            Some((w, floor((w[0].min(w[1]) * (g.phi * 0.5).m_tan()).min(MAX_MM))))
        };
        let least = |all: Vec<([f64; 2], f64)>| {
            all.into_iter().fold(([MAX_MM; 2], MAX_MM), |(w, r), (x, y)| {
                ([w[0].min(x[0]), w[1].min(x[1])], r.min(y))
            })
        };
        let own = (out.max_distance_mm, out.max_radius_mm);
        let rooms: Vec<Option<([f64; 2], f64)>> =
            ring.iter().map(|r| if ok(r) { room(r) } else { None }).collect();
        let on_chain: Vec<([f64; 2], f64)> = ring
            .iter()
            .zip(&rooms)
            .filter(|(r, _)| out.chain.contains(&to_ref(r)))
            .filter_map(|(_, x)| *x)
            .chain([own])
            .collect();
        (out.chain_max_distance_mm, out.chain_max_radius_mm) = least(on_chain);
        (out.loop_max_distance_mm, out.loop_max_radius_mm) =
            least(rooms.into_iter().flatten().chain([own]).collect());
    }
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
    if !sharp(faces, ra, rb) {
        return Err(none());
    }
    if !faces.regions[ra].curved && on_ellipse_rim(faces, ra, a, b, tol) {
        return Err(Error::invalid(
            "edges",
            format!("edge {n}: {}", lower_first(ELLIPSE_RIM.trim_end_matches('.'))),
        ));
    }
    edge_geom(faces, ra, rb, a, b, ta, tb).map_err(|why| {
        Error::invalid(
            "edges",
            format!("edge {n}: {}", lower_first(why.trim_end_matches('.'))),
        )
    })
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

const ELLIPSE_RIM: &str = "The edge goes around an ellipse. Fillet and chamfer work on straight edges and round rims, not on ellipses yet.";

/// whether `ring`, an outline of the flat face `flat`, goes around an ellipse that is no circle
fn ellipse_rim(faces: &Faces<'_>, flat: usize, ring: &[Run]) -> bool {
    let Some(frame) = Frame::from_normal(ring[0].a, faces.regions[flat].normal, None) else {
        return false;
    };
    // positions are stored as f32
    let tol = (faces.size * 1e-6).max(1e-4);
    let pts: Vec<V2> = ring.iter().map(|r| frame.project(r.a)).collect();
    crate::poly2d::ellipse_fit(&pts, tol).is_some_and(|(a, b)| a - b > tol * 10.0)
}

/// the outline of the flat face `flat` that the edge from `a` to `b` lies along, when it goes around an ellipse
fn on_ellipse_rim(faces: &Faces<'_>, flat: usize, a: V3, b: V3, tol: f64) -> bool {
    faces.rings(flat).iter().any(|ring| {
        ring.iter()
            .any(|r| dist_to_segment(a, r.a, r.b) < tol && dist_to_segment(b, r.a, r.b) < tol)
            && ellipse_rim(faces, flat, ring)
    })
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

/// One tool along edges that run on into each other round a curve, mitered where they meet.
#[allow(clippy::cast_possible_truncation, reason = "vertex counts fit u32")]
fn sweep(chain: &[(usize, Geom)], p: Profile, closed: bool) -> Result<TriMesh> {
    let (n, g0) = chain[0];
    let short = || Error::invalid("edges", format!("edge {n} is too short for this size"));
    let v = vec3::cross(g0.d, g0.ta);
    let w = if vec3::dot(g0.tb, v) < 0.0 {
        vec3::scale(v, -1.0)
    } else {
        v
    };
    let mut poly = Polygon::simple(section(&g0, p));
    poly.normalize_orientation();
    let sec: Vec<V2> = poly.vertices().collect();
    let at = |o: V3, u: V3, q: V2| vec3::add(o, vec3::add(vec3::scale(u, q[0]), vec3::scale(w, q[1])));
    let capped = |g: &Geom, i: usize| -> Vec<V3> {
        let o = g.end_offset(i);
        sec.iter()
            .map(|&q| {
                let base = at(g.a, g.ta, q);
                vec3::add(base, vec3::scale(g.d, g.reach(i, base, o)))
            })
            .collect()
    };
    let k = chain.len();
    let mut rings = Vec::with_capacity(k + 1);
    if !closed {
        rings.push(capped(&g0, 0));
    }
    for i in usize::from(!closed)..k {
        let (g, h) = (chain[(i + k - 1) % k].1, chain[i].1);
        let m = vec3::scale(vec3::add(g.ta, h.ta), 1.0 / (1.0 + vec3::dot(g.ta, h.ta)));
        rings.push(sec.iter().map(|&q| at(h.a, m, q)).collect());
    }
    if !closed {
        rings.push(capped(&chain[k - 1].1, 1));
    }
    // every point of the section moves forward along each stretch, or the tool turns inside out
    for (i, (_, g)) in chain.iter().enumerate() {
        let (r0, r1) = (&rings[i], &rings[(i + 1) % rings.len()]);
        if r0
            .iter()
            .zip(r1)
            .any(|(a, b)| vec3::dot(vec3::sub(*b, *a), g.d) < 1e-6)
        {
            return Err(short());
        }
    }
    let nq = sec.len();
    let id = |r: usize, j: usize| (r * nq + j % nq) as u32;
    let mut m = TriMesh::default();
    for r in &rings {
        m.positions.extend(r);
    }
    for i in 0..k {
        let (r0, r1) = (i, (i + 1) % rings.len());
        for j in 0..nq {
            m.triangles.push([id(r0, j), id(r0, j + 1), id(r1, j + 1)]);
            m.triangles.push([id(r0, j), id(r1, j + 1), id(r1, j)]);
        }
    }
    if !closed {
        let last = rings.len() - 1;
        for t in crate::poly2d::triangulate(&poly)? {
            let t = t.map(|x| x as usize);
            m.triangles.push([id(0, t[0]), id(0, t[2]), id(0, t[1])]);
            m.triangles.push([id(last, t[0]), id(last, t[1]), id(last, t[2])]);
        }
    }
    if m.volume() < 0.0 {
        m.flip();
    }
    Ok(m)
}

/// Edges in a row along a round, each with its number in the request.
type Chain = Vec<(usize, Geom)>;

/// What `chains` fails with: the places in `geoms` of the edges it is about, and why.
type ChainFail = (Vec<usize>, Error);

/// Runs of edges that meet along a round, turned one way, and whether each closes a loop; `nums` as the request counts.
/// a failure names the edges it is about, as places in `geoms`
fn chains(geoms: &[Geom], nums: &[usize]) -> std::result::Result<Vec<(Chain, bool)>, ChainFail> {
    let mut at: HashMap<Key, Vec<(usize, usize)>> = HashMap::new();
    for (i, g) in geoms.iter().enumerate() {
        for (e, p) in [g.a, g.b].into_iter().enumerate() {
            if g.ends[e].runs_on.is_some() {
                at.entry(key(p)).or_default().push((i, e));
            }
        }
    }
    let mut next: Vec<[Option<usize>; 2]> = vec![[None; 2]; geoms.len()];
    let mut joints: Vec<&Vec<(usize, usize)>> = at.values().filter(|l| l.len() > 1).collect();
    joints.sort_by_key(|l| l.iter().map(|x| x.0).min());
    for list in joints {
        let names = || {
            let mut l: Vec<String> = list.iter().map(|&(i, _)| nums[i].to_string()).collect();
            let last = l.pop().unwrap_or_default();
            format!("{} and {last}", l.join(", "))
        };
        let all = || list.iter().map(|x| x.0).collect::<Vec<_>>();
        let [(i, ei), (j, ej)] = list[..] else {
            return Err((
                all(),
                Error::invalid(
                    "edges",
                    format!(
                        "edges {} meet at one point along a round; pick each edge once",
                        names()
                    ),
                ),
            ));
        };
        let (gi, gj) = (&geoms[i], &geoms[j]);
        if i == j
            || gi.ra != gj.ra
            || gi.ends[ei].runs_on != Some(gi.ra)
            || gj.ends[ej].runs_on != Some(gj.ra)
        {
            return Err((
                all(),
                Error::invalid(
                    "edges",
                    format!(
                        "edges {} meet along a round; pick both from the flat face they share",
                        names()
                    ),
                ),
            ));
        }
        next[i][ei] = Some(j);
        next[j][ej] = Some(i);
    }
    let count = geoms.len();
    let mut seen = vec![false; count];
    let mut out = Vec::new();
    // open chains from their first edge, then closed loops
    let starts = (0..count)
        .filter(|&i| next[i].iter().any(Option::is_none))
        .chain(0..count);
    for s in starts {
        if seen[s] {
            continue;
        }
        seen[s] = true;
        let (mut g, mut to) = (geoms[s], next[s]);
        if to[0].is_some() && to[1].is_none() {
            (g, to) = (g.flipped(), [to[1], to[0]]);
        }
        let mut list = vec![(nums[s], g)];
        let mut closed = false;
        let mut on = to[1];
        while let Some(j) = on {
            if j == s {
                closed = true;
                break;
            }
            if seen[j] {
                break;
            }
            seen[j] = true;
            let (mut h, mut hto) = (geoms[j], next[j]);
            if list.last().is_some_and(|(_, l)| key(h.a) != key(l.b)) {
                (h, hto) = (h.flipped(), [hto[1], hto[0]]);
            }
            list.push((nums[j], h));
            on = hto[1];
        }
        out.push((list, closed));
    }
    Ok(out)
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

/// a failure of the tools and the edges it is about, as places in the list asked for (none: the whole call)
struct EdgeFail {
    at: Vec<usize>,
    err: Error,
}

impl From<Error> for EdgeFail {
    fn from(err: Error) -> Self {
        Self { at: Vec::new(), err }
    }
}

fn on(at: Vec<usize>) -> impl FnOnce(Error) -> EdgeFail {
    move |err| EdgeFail { at, err }
}

/// the tools for `edges`, which the request numbers `num` (from 1)
#[allow(clippy::too_many_lines, reason = "checks, pieces and corners in one pass")]
fn tools(
    mesh: &TriMesh,
    edges: &[EdgeRef],
    num: &[usize],
    profile: Profile,
) -> std::result::Result<Tools, EdgeFail> {
    mesh.validate("mesh")?;
    let profile = check_profile(profile)?;
    if edges.is_empty() {
        return Err(Error::invalid("edges", "pick at least one edge").into());
    }
    let faces = Faces::new(mesh);
    for (i, e) in edges.iter().enumerate() {
        if let Some(keys) = e.keys {
            let identities = mesh
                .faces
                .as_ref()
                .ok_or_else(|| {
                    Error::invalid(
                        "faceReference",
                        "the face reference is missing; repair the reference before editing",
                    )
                })
                .map_err(on(vec![i]))?;
            for key in keys {
                crate::faces::resolve_key(mesh, identities, key).map_err(on(vec![i]))?;
            }
        }
    }
    // stored keys must resolve uniquely; only an unkeyed pick may use its place.
    let found: Vec<EdgeRef> = edges
        .iter()
        .enumerate()
        .map(|(i, e)| match relocate(mesh, e) {
            Some((_, true)) => Err(EdgeFail {
                at: vec![i],
                err: Error::invalid(
                    "faceReference",
                    format!("edge {} was split; repair the reference before editing", num[i]),
                ),
            }),
            Some((r, false)) => Ok(r),
            None if e.keys.is_some() => {
                let same_rim = e.center.is_some()
                    && keys_at(mesh, e)
                        .zip(e.keys)
                        .is_some_and(|(a, b)| a == b || a == [b[1], b[0]]);
                if same_rim {
                    Ok(*e)
                } else {
                    Err(EdgeFail {
                        at: vec![i],
                        err: Error::invalid(
                            "faceReference",
                            format!(
                                "edge {} has a missing face reference; repair the reference before editing",
                                num[i]
                            ),
                        ),
                    })
                }
            }
            None => Ok(keyed(mesh, e)),
        })
        .collect::<std::result::Result<_, EdgeFail>>()?;
    // an edge asked for twice is cut once: a second tool on the same edge leaves slivers the boolean cannot close
    let tol = REF_MM.max(faces.size * 1e-7);
    let mut notes = Vec::new();
    let mut once: Vec<(usize, &EdgeRef)> = Vec::new();
    for (i, e) in found.iter().enumerate() {
        match once.iter().find(|(_, o)| same_edge(o, e, tol)) {
            Some(&(j, _)) => notes.push(format!(
                "edge {} is edge {} again and was taken once",
                num[i], num[j]
            )),
            None => once.push((i, e)),
        }
    }
    // Round edges get their own tools; the straight ones go on as before, numbered as the request numbers them.
    let mut rims = Vec::new();
    let mut straight = Vec::new();
    for &(i, e) in &once {
        if e.center.is_some() {
            rims.push((i, num[i], rim::of_ref(mesh, e, num[i]).map_err(on(vec![i]))?));
        } else {
            straight.push((i, num[i], e));
        }
    }
    let geoms = straight
        .iter()
        .map(|&(i, n, e)| resolve(&faces, n, e).map_err(on(vec![i])))
        .collect::<std::result::Result<Vec<_>, EdgeFail>>()?;
    let mut strips: Vec<(usize, usize, [V3; 4])> = Vec::new();
    for (i, g) in geoms.iter().enumerate() {
        let widths = match profile {
            Profile::Chamfer { d1, d2 } => [d1, d2],
            Profile::Fillet { radius, .. } => [setback(g, radius); 2],
        };
        for (side, &w) in widths.iter().enumerate() {
            if !fits(&faces, g, side, w) {
                let max = max_width(&faces, g, side);
                return Err(on(vec![straight[i].0])(match profile {
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
                }));
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
                return Err(EdgeFail {
                    at: vec![straight[i].0, straight[j].0],
                    err: Error::invalid(
                        what,
                        format!(
                            "{v} mm does not fit; edges {} and {} would overlap on one face",
                            straight[i].1, straight[j].1
                        ),
                    ),
                });
            }
        }
    }
    let mut out = Tools {
        refs: found.clone(),
        notes,
        ..Tools::default()
    };
    for &(i, n, ref r) in &rims {
        let widths = r.widths(profile);
        for (side, &w) in widths.iter().enumerate() {
            if w > r.room[side] + 1e-9 {
                let max = (r.room[side] * 1000.0 + 1e-6).floor() / 1000.0;
                return Err(on(vec![i])(match profile {
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
                }));
            }
        }
        let m = r.tool(profile, n).map_err(on(vec![i]))?;
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
    for g in &geoms {
        out.edges.push(EdgeInfo {
            convex: g.convex,
            dihedral_deg: g.dihedral_deg(),
            length_mm: g.len,
        });
    }
    let nums: Vec<usize> = straight.iter().map(|s| s.1).collect();
    let place = |k: &[usize]| k.iter().map(|&k| straight[k].0).collect::<Vec<_>>();
    let chained = chains(&geoms, &nums).map_err(|(k, err)| EdgeFail { at: place(&k), err })?;
    for (chain, closed) in chained {
        let (n, g) = chain[0];
        let at: Vec<usize> = chain
            .iter()
            .filter_map(|c| straight.iter().find(|s| s.1 == c.0).map(|s| s.0))
            .collect();
        let m = if chain.len() == 1 {
            piece(&g, profile, n)
        } else {
            sweep(&chain, profile, closed)
        }
        .map_err(on(at))?;
        if g.convex {
            out.cut.push(m);
        } else {
            out.join.push(m);
        }
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
                return Err(EdgeFail {
                    at: place(&list),
                    err: Error::invalid(
                        "edges",
                        format!(
                            "the corner at ({:.3}, {:.3}, {:.3}) joins more than three fillets; leave some of its edges out",
                            v[0], v[1], v[2]
                        ),
                    ),
                });
            }
            let m = sphere_corner(&faces, v, &gs, radius, tolerance).map_err(on(place(&list)))?;
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

/// whether two found references are one edge: the same ends either way round, or the same rim
fn same_edge(a: &EdgeRef, b: &EdgeRef, tol: f64) -> bool {
    let near = |p: V3, q: V3| vec3::len(vec3::sub(p, q)) < tol;
    match (a.center, b.center) {
        (Some(ca), Some(cb)) => {
            near(ca, cb)
                && vec3::dot(a.face, b.face) > 0.999
                && (vec3::len(vec3::sub(a.a, ca)) - vec3::len(vec3::sub(b.a, cb))).abs() < tol
        }
        (None, None) => (near(a.a, b.a) && near(a.b, b.b)) || (near(a.a, b.b) && near(a.b, b.a)),
        _ => false,
    }
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
    let (segs, runs) = runs_between(mesh, &key, [k0, k1])?;
    let spans: Vec<_> = runs
        .iter()
        .filter_map(|r| span_of(mesh, r).map(|(a, b, l)| (a, b, l, r)))
        .collect();
    let &(a, b, _, run) = spans.iter().max_by(|x, y| x.2.total_cmp(&y.2))?;
    // The normal of the face `face` faced, as it is now.
    let t0 = mesh.triangles.iter().enumerate().find(|&(t, _)| key(t) == k0)?.1;
    let face = vec3::normalize(mesh.normal(*t0))?;
    // faces that meet along a curve (a flat face and a round) have no one straight edge: it is found by its place
    let tol = REF_MM.max(mesh.bounds().map_or(1.0, |b| b.diagonal()) * 1e-7);
    let point = |x: u32| mesh.positions[x as usize];
    if run
        .iter()
        .any(|&(u, v)| [u, v].into_iter().any(|x| dist_to_segment(point(x), a, b) > tol))
    {
        let near = |p: V3| {
            segs.iter()
                .flat_map(|&(u, v)| [point(u), point(v)])
                .find(|&q| vec3::len(vec3::sub(q, p)) < tol)
        };
        return Some((
            EdgeRef {
                a: near(e.a)?,
                b: near(e.b)?,
                face,
                moved: false,
                center: None,
                keys: e.keys,
            },
            false,
        ));
    }
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

/// Mesh edges, and the same edges grouped into runs.
type Runs = (Vec<(u32, u32)>, Vec<Vec<(u32, u32)>>);

/// The mesh edges between the faces keyed `keys`, and those joined into runs through shared vertices.
fn runs_between(mesh: &TriMesh, key: &dyn Fn(usize) -> u64, [k0, k1]: [u64; 2]) -> Option<Runs> {
    let mut by_edge: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (t, tri) in mesh.triangles.iter().enumerate() {
        for j in 0..3 {
            let (u, v) = (tri[j], tri[(j + 1) % 3]);
            by_edge.entry((u.min(v), u.max(v))).or_default().push(t);
        }
    }
    let mut segs: Vec<(u32, u32)> = by_edge
        .iter()
        .filter(|(_, ts)| {
            let [t0, t1] = ts[..] else { return false };
            let (a, b) = (key(t0), key(t1));
            (a == k0 && b == k1) || (a == k1 && b == k0)
        })
        .map(|(&uv, _)| uv)
        .collect();
    // sorted, and runs in the order of their first segment: map order differs between runs and builds
    segs.sort_unstable();
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
    let mut slot: HashMap<u32, usize> = HashMap::new();
    let mut runs: Vec<Vec<(u32, u32)>> = Vec::new();
    for &(u, v) in &segs {
        let r = run_root(&mut parent, u);
        let i = *slot.entry(r).or_insert_with(|| {
            runs.push(Vec::new());
            runs.len() - 1
        });
        runs[i].push((u, v));
    }
    Some((segs, runs))
}

/// A run's two farthest points along its first segment, and how far apart they are.
fn span_of(mesh: &TriMesh, run: &[(u32, u32)]) -> Option<(V3, V3, f64)> {
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
}

/// what a failure says, as a code a client can switch on
fn code_of(e: &Error) -> &'static str {
    let s = e.to_string();
    let has = |w: &str| s.contains(w);
    if matches!(
        e,
        Error::Invalid {
            what: "faceReference",
            ..
        }
    ) || has("face reference")
    {
        "face_reference"
    } else if has("cannot blend") || has("more than three fillets") {
        "corner"
    } else if has("overlap") {
        "overlap"
    } else if has("meet along a round") || has("meet at one point along a round") {
        "round_join"
    } else if has("does not fit") || has("reaches past") || has("too short") {
        "does_not_fit"
    } else if has("no sharp edge") || has("not there any more") || has("more than one edge matches") {
        "not_found"
    } else {
        "unsupported"
    }
}

/// The tools for `edges`; with `skip`, an edge that fails is left out and the rest go on, the later one of a pair
/// or corner that fails together. A call that can do none of them fails as the first one did.
fn tools_skipping(
    mesh: &TriMesh,
    edges: &[EdgeRef],
    profile: Profile,
    skip: bool,
) -> Result<(Tools, Vec<Skipped>)> {
    let mut left: Vec<usize> = (0..edges.len()).collect();
    let mut skipped: Vec<Skipped> = Vec::new();
    let mut first = None;
    loop {
        let list: Vec<EdgeRef> = left.iter().map(|&i| edges[i]).collect();
        let num: Vec<usize> = left.iter().map(|&i| i + 1).collect();
        match tools(mesh, &list, &num, profile) {
            Ok(mut t) => {
                if !skipped.is_empty() {
                    // every edge keeps its place in the refs, as asked when it was left out
                    let mut refs = edges.to_vec();
                    for (k, &i) in left.iter().enumerate() {
                        refs[i] = t.refs[k];
                    }
                    t.refs = refs;
                    skipped.sort_by_key(|x| x.index);
                }
                return Ok((t, skipped));
            }
            Err(f) if !skip || f.at.is_empty() => return Err(first.unwrap_or(f.err)),
            Err(f) => {
                let k = f.at.iter().copied().max().unwrap_or(0);
                let i = left.remove(k);
                let message = match &f.err {
                    Error::Invalid { why, .. } | Error::Geometry { why, .. } => why.clone(),
                    e => e.to_string(),
                };
                skipped.push(Skipped {
                    index: i,
                    code: code_of(&f.err),
                    message,
                });
                if first.is_none() {
                    first = Some(f.err);
                }
                if left.is_empty() {
                    return Err(first.unwrap_or_else(|| Error::invalid("edges", "pick at least one edge")));
                }
            }
        }
    }
}

pub fn apply(
    mesh: &TriMesh,
    edges: &[EdgeRef],
    profile: Profile,
    opts: &BooleanOptions,
) -> Result<EdgeResult> {
    apply_some(mesh, edges, profile, opts, false)
}

/// `apply`, leaving out the edges that fail when `skip` is set (each in `skipped`, with why).
pub fn apply_some(
    mesh: &TriMesh,
    edges: &[EdgeRef],
    profile: Profile,
    opts: &BooleanOptions,
    skip: bool,
) -> Result<EdgeResult> {
    // the round's strips follow every vertex along the edge: the faces the edges touch from their corners alone
    // first (a round edge, a circle, every flat face as before)
    let coarse = if edges.iter().any(|e| e.center.is_some()) {
        crate::remesh::coarsen_flat(mesh)
    } else {
        let segments: Vec<(V3, V3)> = edges.iter().map(|e| (e.a, e.b)).collect();
        crate::remesh::coarsen_flat_touching(mesh, &segments)
    };
    let mesh = &coarse;
    let (t, skipped) = tools_skipping(mesh, edges, profile, skip)?;
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
    let Some((out, mut r)) = last else {
        return Err(Error::invalid("edges", "pick at least one edge"));
    };
    let out = boolean::tidy(out, &mut r);
    let mut notes = t.notes;
    for x in &skipped {
        let why = x
            .message
            .split_once(": ")
            .filter(|(h, _)| h.starts_with("edge "))
            .map_or(x.message.as_str(), |(_, w)| w);
        notes.push(format!("edge {} was left as it was: {why}", x.index + 1));
    }
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
        notes,
        skipped,
    })
}

pub fn preview(mesh: &TriMesh, edges: &[EdgeRef], profile: Profile) -> Result<(TriMesh, TriMesh)> {
    preview_some(mesh, edges, profile, false).map(|(cut, join, _)| (cut, join))
}

/// `preview`, leaving out the edges that fail when `skip` is set.
pub fn preview_some(
    mesh: &TriMesh,
    edges: &[EdgeRef],
    profile: Profile,
    skip: bool,
) -> Result<(TriMesh, TriMesh, Vec<Skipped>)> {
    let (t, skipped) = tools_skipping(mesh, edges, profile, skip)?;
    let mut cut = TriMesh::default();
    for m in &t.cut {
        cut.append(m);
    }
    let mut join = TriMesh::default();
    for m in &t.join {
        join.append(m);
    }
    Ok((cut, join, skipped))
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

    /// The smallest angles of the triangles on the plane z = `z`, sorted.
    fn angles_at(m: &TriMesh, z: f64) -> Vec<f64> {
        let mut out: Vec<f64> = m
            .triangles
            .iter()
            .map(|&t| m.corners(t))
            .filter(|c| c.iter().all(|p| (p[2] - z).abs() < 1e-6))
            .map(|[a, b, c]| crate::remesh::min_angle(a, b, c))
            .collect();
        out.sort_by(f64::total_cmp);
        out
    }

    #[test]
    fn a_round_leaves_the_fill_of_faces_it_does_not_reach() {
        // A plinth with its top edges and upright corners rounded: the result's flat faces are filled again, the
        // bottom too, round the corner arcs. Rounding an edge of a block joined on top then must not take the
        // bottom back to a fan from its corners: next to the corner rounds the fill cannot win it back.
        let up = [0.0, 0.0, 1.0];
        let side = |x: f64, y: f64, n: V3| e([x, y, 0.0], [x, y, 6.0], n);
        let plinth = build::box_mesh([0.0; 3], [80.0, 26.0, 6.0]);
        let corners = [
            side(0.0, 0.0, [0.0, -1.0, 0.0]),
            side(80.0, 0.0, [1.0, 0.0, 0.0]),
            side(80.0, 26.0, [0.0, 1.0, 0.0]),
            side(0.0, 26.0, [-1.0, 0.0, 0.0]),
        ];
        let mut edges = corners.to_vec();
        edges.extend(top_loop(80.0, 26.0, 6.0));
        let first = run(&plinth, &edges, fillet(2.0)).unwrap();
        sound(&first);
        let before = angles_at(&first.mesh, 0.0);
        assert!(before[before.len() / 2] > 20.0, "{before:?}");
        // a block joined on top, its own top front edge rounded
        let block = build::box_mesh([30.0, 8.0, 6.0], [50.0, 18.0, 16.0]);
        let joined = boolean::boolean(&[first.mesh], &[block], BoolOp::Union, &BooleanOptions::default())
            .unwrap()
            .0;
        let between = angles_at(&joined, 0.0);
        assert!(between[between.len() / 2] > 20.0, "{between:?}");
        let second = run(
            &joined,
            &[e([30.0, 8.0, 16.0], [50.0, 8.0, 16.0], up)],
            fillet(1.0),
        )
        .unwrap();
        sound(&second);
        let after = angles_at(&second.mesh, 0.0);
        assert!(
            after[after.len() / 2] > 20.0,
            "median {} of {:?}",
            after[after.len() / 2],
            after
        );
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
    fn a_moved_edge_on_a_split_face_requires_repair() {
        let m = slotted(20.0);
        // The edge where the top meets the slot's near wall.
        let e = keyed(&m, &pick(&m, [0.0, 0.0, 1.0], [19.9, 15.0, 20.0]).edge);
        assert!(e.keys.is_some());
        assert!((e.a[0] - 20.0).abs() < 1e-9 && (e.b[0] - 20.0).abs() < 1e-9);
        // the top key still names two fragments, even though this pair meets once.
        let moved = slotted(25.0);
        let error = apply(&moved, &[e], chamfer(1.0), &BooleanOptions::default()).unwrap_err();
        assert!(error.to_string().contains("split") && error.to_string().contains("repair"));
    }

    #[test]
    fn an_edge_is_found_by_unique_faces_after_it_moved() {
        let mut m = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        crate::faces::with_key_salt(Some(1), || crate::faces::base_keys(&mut m));
        let e = keyed(&m, &pick(&m, [0.0, 0.0, 1.0], [39.9, 15.0, 20.0]).edge);
        let moved = crate::xform::transformed(&m, &crate::xform::translation([5.0, 0.0, 0.0]));
        let r = apply(&moved, &[e], chamfer(1.0), &BooleanOptions::default()).unwrap();
        assert!(r.report.watertight && r.notes.is_empty());
        assert!(
            (r.report.volume_change_mm3 + 15.0).abs() < 1e-6,
            "{}",
            r.report.volume_change_mm3
        );
        assert!((r.refs[0].a[0] - 45.0).abs() < 1e-9 && r.refs[0].keys == e.keys);
        let by_place = EdgeRef { keys: None, ..e };
        let err = apply(&moved, &[by_place], chamfer(1.0), &BooleanOptions::default()).unwrap_err();
        assert!(err.to_string().contains("no sharp edge"), "{err}");
    }

    #[test]
    fn a_split_keyed_edge_requires_repair() {
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
        let error = apply(&m, &[e], chamfer(1.0), &BooleanOptions::default())
            .unwrap_err()
            .to_string();
        assert!(error.contains("split") && error.contains("repair"), "{error}");
    }

    #[test]
    fn a_call_that_may_leave_edges_out_does_the_rest() {
        let mut b = build::box_mesh([0.0; 3], [40.0, 30.0, 20.0]);
        crate::faces::with_key_salt(Some(1), || crate::faces::base_keys(&mut b));
        let split = keyed(&b, &pick(&b, [0.0, 0.0, 1.0], [20.0, 0.1, 20.0]).edge);
        let back = keyed(&b, &pick(&b, [0.0, 0.0, 1.0], [20.0, 29.9, 20.0]).edge);
        let notch = build::box_mesh([10.0, -1.0, 10.0], [14.0, 5.0, 21.0]);
        let m = crate::faces::with_key_salt(Some(2), || {
            boolean::boolean(&[b], &[notch], BoolOp::Difference, &BooleanOptions::default())
                .unwrap()
                .0
        });
        let opts = BooleanOptions::default();
        let err = apply(&m, &[split, back], chamfer(1.0), &opts)
            .unwrap_err()
            .to_string();
        assert!(err.contains("split"), "{err}");
        let r = apply_some(&m, &[split, back], chamfer(1.0), &opts, true).unwrap();
        sound(&r);
        assert_eq!(r.skipped.len(), 1);
        assert_eq!((r.skipped[0].index, r.skipped[0].code), (0, "face_reference"));
        // the back edge alone: 40 mm at 0.5 mm2
        assert!(
            (r.report.volume_change_mm3 + 20.0).abs() < 1e-6,
            "{}",
            r.report.volume_change_mm3
        );
        assert_eq!(r.refs.len(), 2);
        assert_eq!(r.refs[0], split);
        assert!(
            r.notes.iter().any(|n| n.starts_with("edge 1 was left as it was")),
            "{:?}",
            r.notes
        );
        // with nothing it can do, it fails as the first edge did
        let none = apply_some(&m, &[split], chamfer(1.0), &opts, true)
            .unwrap_err()
            .to_string();
        assert_eq!(none, err);
        assert!(none.contains("split"), "{none}");
    }

    #[test]
    fn a_corner_it_cannot_blend_leaves_the_last_of_its_edges_sharp() {
        let m = l_bracket();
        let inner = e([4.0, 0.0, 4.0], [4.0, 20.0, 4.0], [0.0, 0.0, 1.0]);
        let side = [0.0, -1.0, 0.0];
        let a = e([4.0, 0.0, 4.0], [30.0, 0.0, 4.0], side);
        let b = e([4.0, 0.0, 4.0], [4.0, 0.0, 25.0], side);
        let r = apply_some(&m, &[inner, a, b], fillet(1.0), &BooleanOptions::default(), true).unwrap();
        sound(&r);
        assert_eq!(r.skipped.len(), 1);
        assert_eq!((r.skipped[0].index, r.skipped[0].code), (2, "corner"));
        assert!(
            r.skipped[0].message.contains("cannot blend"),
            "{}",
            r.skipped[0].message
        );
        // nothing left out when every edge goes through
        let ok = apply_some(&m, &[inner, a], fillet(1.0), &BooleanOptions::default(), true).unwrap();
        assert!(ok.skipped.is_empty());
        let same = apply(&m, &[inner, a], fillet(1.0), &BooleanOptions::default()).unwrap();
        assert_eq!(ok.mesh, same.mesh);
    }

    #[test]
    fn a_missing_edge_key_requires_repair_instead_of_using_its_old_place() {
        let m = slotted(20.0);
        let e = EdgeRef {
            keys: Some([1, 2]),
            ..pick(&m, [0.0, 0.0, 1.0], [19.9, 15.0, 20.0]).edge
        };
        let error = apply(&m, &[e], chamfer(1.0), &BooleanOptions::default())
            .unwrap_err()
            .to_string();
        assert!(error.contains("missing") && error.contains("repair"), "{error}");
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

    /// A cone 10 mm across its base and 5 mm high, base down on z = 0.
    fn cone() -> TriMesh {
        let tri = vec![Polygon::simple(vec![[0.0, 0.0], [10.0, 0.0], [0.0, 5.0]])];
        let m = crate::sketch::revolve(&Frame::WORLD, &tri, [0.0, 0.0], [0.0, 1.0], 360.0).unwrap();
        crate::xform::transformed(
            &m,
            &crate::xform::rotation_about([0.0; 3], [1.0, 0.0, 0.0], PI / 2.0),
        )
    }

    #[test]
    fn round_rims_and_cone_rims() {
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
        // a cone's base rim is a ring of straight edges, each ending halfway into the next facet
        let m = cone();
        let p = pick(&m, [0.0, 0.0, -1.0], [9.9, 0.0, 0.0]);
        assert!(p.supported && p.convex, "{:?}", p.reason);
        // each facet is a chord's plane, a little steeper than the cone
        assert!(
            (p.dihedral_deg - 0.5f64.m_atan().to_degrees()).abs() < 0.5,
            "{}",
            p.dihedral_deg
        );
        assert!(p.ring.len() > 12 && p.ring.iter().all(|l| l.supported));
        assert_eq!(p.chain.len(), p.ring.len());
        let one = run(&m, &[p.edge], fillet(1.0)).unwrap();
        sound(&one);
        let ring: Vec<EdgeRef> = p.ring.iter().map(|l| l.edge).collect();
        let all = run(&m, &ring, fine(1.0)).unwrap();
        sound(&all);
        // the corner's cross section, swept round between the rim and where the round meets the base
        let half = 0.5f64.m_atan() * 0.5;
        let s = 1.0 / half.m_tan();
        let area = s - (PI - 2.0 * half) / 2.0;
        let lost = m.volume() - all.mesh.volume();
        let (lo, hi) = (area * 2.0 * PI * (10.0 - s), area * 2.0 * PI * 10.0);
        assert!(lost > lo && lost < hi, "{lost} not in {lo}..{hi}");
        assert!(lost > m.volume() - one.mesh.volume());
    }

    #[test]
    fn the_pick_offers_what_the_ops_take_on_its_chain_and_loop() {
        // a slot with round ends in a plate: its straight sides allow more than the facets at its ends
        let f = Frame::WORLD;
        let b = build::box_mesh([-20.0, -10.0, 0.0], [20.0, 10.0, 6.0]);
        let mut ring = Vec::new();
        for (cx, a0) in [(3.25, -90.0f64), (-3.25, 90.0)] {
            for k in 0..=16 {
                let (sn, cs) = (a0 + 180.0 * f64::from(k) / 16.0).to_radians().m_sin_cos();
                ring.push([cx + 3.25 * cs, 3.25 * sn]);
            }
        }
        let slot = build::extrude(&[Polygon::simple(ring)], &f, -1.0, 8.0).unwrap();
        let m = boolean::boolean(&[b], &[slot], BoolOp::Difference, &BooleanOptions::default())
            .unwrap()
            .0;
        let p = pick(&m, [0.0, 0.0, 1.0], [0.0, 3.4, 6.0]);
        assert!(p.supported, "{:?}", p.reason);
        assert!(p.loop_max_radius_mm <= p.chain_max_radius_mm && p.chain_max_radius_mm <= p.max_radius_mm);
        let all: Vec<EdgeRef> = p.ring.iter().filter(|l| l.supported).map(|l| l.edge).collect();
        // the loop's own limit goes through, and a hair over it is refused
        let at = p.loop_max_radius_mm;
        sound(&run(&m, &all, fillet(at)).unwrap());
        let err = run(&m, &all, fillet(at + 0.01)).unwrap_err().to_string();
        assert!(err.contains("does not fit"), "{err} against {at}");
        let at = p.loop_max_distance_mm[0].min(p.loop_max_distance_mm[1]);
        sound(&run(&m, &all, chamfer(at)).unwrap());
    }

    #[test]
    fn an_edge_asked_for_twice_is_cut_once() {
        // a round edge, as a coaster's rim is picked by its chain and its loop: cut twice, it gains triangles
        let disk = build::cylinder(&Frame::WORLD, 10.0, 0.0, 5.0, 64);
        let rim = pick(&disk, [0.0, 0.0, 1.0], [9.9, 0.0, 5.0]).edge;
        let one = run(&disk, &[rim], fillet(1.0)).unwrap();
        let r = run(&disk, &[rim, rim], fillet(1.0)).unwrap();
        sound(&r);
        assert_eq!(r.mesh.triangles.len(), one.mesh.triangles.len());
        assert_eq!(r.mesh, one.mesh);
        let c = run(&disk, &[rim, rim], chamfer(0.6)).unwrap();
        assert_eq!(c.mesh, run(&disk, &[rim], chamfer(0.6)).unwrap().mesh);
        let b = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let top = pick(&b, [0.0, 0.0, 1.0], [8.0, 0.4, 5.0]).edge;
        let back = EdgeRef {
            a: top.b,
            b: top.a,
            ..top
        };
        let one = run(&b, &[top], fillet(1.0)).unwrap();
        for twice in [vec![top, top], vec![top, back]] {
            let r = run(&b, &twice, fillet(1.0)).unwrap();
            sound(&r);
            assert_eq!(r.mesh, one.mesh);
            assert_eq!(r.refs.len(), 2);
            assert_eq!(
                r.notes,
                vec!["edge 2 is edge 1 again and was taken once".to_owned()]
            );
        }
    }

    /// A plate `x` by `y` by `z`, each upright corner from (x, 0) on rounded to its radius (0 stays sharp) in `steps`.
    fn plate(x: f64, y: f64, z: f64, radii: [f64; 4], steps: usize) -> TriMesh {
        let mut pts = Vec::new();
        let corners = [
            (x, 0.0, -1.0, 1.0),
            (x, y, -1.0, -1.0),
            (0.0, y, 1.0, -1.0),
            (0.0, 0.0, 1.0, 1.0),
        ];
        for (i, (cx, cy, sx, sy)) in corners.into_iter().enumerate() {
            let r = radii[i];
            if r == 0.0 {
                pts.push([cx, cy]);
                continue;
            }
            let c = [cx + sx * r, cy + sy * r];
            let a0 = (i as f64 - 1.0) * PI / 2.0;
            for k in 0..=steps {
                let (sn, cs) = (a0 + PI / 2.0 * k as f64 / steps as f64).m_sin_cos();
                pts.push([c[0] + r * cs, c[1] + r * sn]);
            }
        }
        build::extrude(&[Polygon::simple(pts)], &Frame::WORLD, 0.0, z).unwrap()
    }

    fn fine(r: f64) -> Profile {
        Profile::Fillet {
            radius: r,
            tolerance: 0.001,
        }
    }

    /// The top loop of `m`, picked on its front edge at `x`.
    fn top_loop_of(m: &TriMesh, x: f64) -> Vec<EdgeRef> {
        let p = pick(m, [0.0, 0.0, 1.0], [x, 0.1, m.bounds().unwrap().max[2]]);
        assert!(p.ring.iter().all(|l| l.supported), "{:?}", p.reason);
        p.ring.iter().map(|l| l.edge).collect()
    }

    #[test]
    fn a_rounded_box_loop_is_one_mitered_round() {
        // the cable clip's base: 30 by 20 by 3, corners rounded to 3 mm in 14 sides each
        let m = plate(30.0, 20.0, 3.0, [3.0; 4], 14);
        let p = pick(&m, [0.0, 0.0, 1.0], [15.0, 0.1, 3.0]);
        assert!(p.supported, "{:?}", p.reason);
        assert_eq!(p.ring.len(), 4 + 4 * 14);
        assert_eq!(p.chain.len(), p.ring.len());
        assert!((p.max_radius_mm - 3.0).abs() < 1e-6, "{}", p.max_radius_mm);
        let edges = top_loop_of(&m, 15.0);
        // the corner's cross section times the path of its centroid, which runs inside the outline
        let path = |off: f64| 2.0 * (30.0 + 20.0) - 8.0 * 3.0 + 2.0 * PI * (3.0 - off);
        for (profile, area, off) in [
            (fine(1.0), 1.0 - PI / 4.0, (10.0 - 3.0 * PI) / (12.0 - 3.0 * PI)),
            (chamfer(0.8), 0.32, 0.8 / 3.0),
        ] {
            let r = run(&m, &edges, profile).unwrap();
            sound(&r);
            assert!(r.corners.is_empty());
            let lost = m.volume() - r.mesh.volume();
            let want = area * path(off);
            assert!((lost - want).abs() / want < 0.01, "{lost} vs {want}");
        }
        // the same loop with some edges given the other way round
        let mut turned = edges.clone();
        for e in turned.iter_mut().step_by(3) {
            (e.a, e.b) = (e.b, e.a);
        }
        let a = run(&m, &edges, fillet(1.0)).unwrap();
        let b = run(&m, &turned, fillet(1.0)).unwrap();
        sound(&b);
        assert!((a.mesh.volume() - b.mesh.volume()).abs() < 1e-6);
        // the round inside the corner cannot be tighter than the corner
        let err = run(&m, &edges, fillet(3.5)).unwrap_err().to_string();
        assert!(err.contains("does not fit"), "{err}");
        sound(&run(&m, &edges, fillet(2.5)).unwrap());
    }

    #[test]
    fn a_straight_edge_into_a_round_ends_halfway_into_it() {
        let m = plate(30.0, 20.0, 3.0, [3.0; 4], 14);
        let p = pick(&m, [0.0, 0.0, 1.0], [15.0, 0.1, 3.0]);
        assert!((p.length_mm - 24.0).abs() < 1e-9);
        let r = run(&m, &[p.edge], fine(1.0)).unwrap();
        sound(&r);
        let lost = m.volume() - r.mesh.volume();
        let want = 24.0 * (1.0 - PI / 4.0);
        assert!((lost - want).abs() / want < 0.01, "{lost} vs {want}");
        // one side of the round on its own, and one stretch of it
        let facet = p.ring[1].edge;
        assert!(p.ring[1].supported);
        sound(&run(&m, &[facet], fillet(0.5)).unwrap());
        let quarter: Vec<EdgeRef> = p.ring[1..15].iter().map(|l| l.edge).collect();
        let r = run(&m, &quarter, fine(1.0)).unwrap();
        sound(&r);
        let lost = m.volume() - r.mesh.volume();
        let want = (1.0 - PI / 4.0) * PI / 2.0 * (3.0 - 0.2234);
        assert!((lost - want).abs() / want < 0.05, "{lost} vs {want}");
    }

    #[test]
    fn a_round_between_sharp_corners_and_loops_with_both() {
        // one corner rounded, the other three sharp
        let m = plate(30.0, 20.0, 4.0, [0.0, 6.0, 0.0, 0.0], 12);
        let edges = top_loop_of(&m, 15.0);
        assert_eq!(edges.len(), 4 + 12);
        for profile in [fillet(1.5), chamfer(1.0)] {
            sound(&run(&m, &edges, profile).unwrap());
        }
        let r = run(&m, &edges, fine(1.5)).unwrap();
        let lost = m.volume() - r.mesh.volume();
        let outline = 2.0 * (30.0 + 20.0) - 2.0 * 6.0 + PI * 3.0;
        let want = 2.25 * (1.0 - PI / 4.0) * outline;
        assert!(lost < want && lost > want * 0.95, "{lost} vs {want}");
        // the round alone, its ends halfway into the straight edges either side
        let arc: Vec<EdgeRef> = edges
            .iter()
            .copied()
            .filter(|e| {
                (e.a[0] - 24.0).min(e.b[0] - 24.0) > -1e-9 && (e.a[1] - 14.0).min(e.b[1] - 14.0) > -1e-9
            })
            .collect();
        assert_eq!(arc.len(), 12);
        sound(&run(&m, &arc, fillet(1.5)).unwrap());
    }

    #[test]
    fn edges_on_curved_faces_fail_in_words() {
        let reason = |m: &TriMesh, t: u32, at: V3| pick_edge(m, t, at).unwrap().reason.unwrap_or_default();
        // a double cone's middle: both faces are curved
        let dia = vec![Polygon::simple(vec![[0.0, -5.0], [10.0, 0.0], [0.0, 5.0]])];
        let m = crate::sketch::revolve(&Frame::WORLD, &dia, [0.0, 0.0], [0.0, 1.0], 360.0).unwrap();
        let (t, at) = m
            .triangles
            .iter()
            .enumerate()
            .find_map(|(t, &tri)| {
                let c = m.corners(tri);
                let mid: Vec<V3> = c.iter().copied().filter(|p| p[1].abs() < 1e-9).collect();
                (mid.len() == 2 && centroid(c)[1] > 0.0).then(|| {
                    (
                        u32::try_from(t).unwrap(),
                        vec3::scale(vec3::add(mid[0], mid[1]), 0.5),
                    )
                })
            })
            .unwrap();
        assert_eq!(
            reason(&m, t, at),
            "Both faces along this edge are curved. Fillet and chamfer need a flat face on one side."
        );
        let edge = pick_edge(&m, t, at).unwrap().edge;
        let err = run(&m, &[edge], fillet(0.5)).unwrap_err().to_string();
        assert!(
            err.contains("edge 1: both faces along this edge are curved"),
            "{err}"
        );
        // a cone's rim picked from the cone: pick it from the base
        let m = cone();
        let side = m
            .triangles
            .iter()
            .position(|&tri| {
                let c = m.corners(tri);
                c.iter().filter(|p| p[2].abs() < 1e-9).count() == 2
                    && vec3::normalize(m.normal(tri)).unwrap()[2] > 0.1
            })
            .unwrap();
        let at = centroid(m.corners(m.triangles[side]));
        let t = u32::try_from(side).unwrap();
        assert_eq!(
            reason(&m, t, at),
            "The picked face is curved. Pick the edge from the flat face on its other side."
        );
        let err = run(&m, &[pick_edge(&m, t, at).unwrap().edge], fillet(0.5))
            .unwrap_err()
            .to_string();
        assert!(err.contains("the picked face is curved"), "{err}");
        // a top sloping across a rounded plate meets each side of a corner at its own angle
        let mut m = plate(30.0, 20.0, 3.0, [3.0; 4], 14);
        m.map_positions(|p| [p[0], p[1], p[2] * (1.0 + 0.05 * p[0])]);
        let up = vec3::normalize([-0.15, 0.0, 1.0]).unwrap();
        let p = pick(&m, up, [15.0, 0.1, 5.25]);
        assert_eq!(
            p.reason.as_deref(),
            Some("The angle between the faces changes along the round the edge runs into.")
        );
        let err = run(&m, &[p.edge], fillet(0.5)).unwrap_err().to_string();
        assert!(err.contains("the angle between the faces changes"), "{err}");
        // the tip of a C: its top edge meets both rounds square on
        let mut c = Vec::new();
        for k in 0..=36 {
            let (sn, cs) = (1.5 * PI * f64::from(k) / 36.0).m_sin_cos();
            c.push([10.0 * cs, 10.0 * sn]);
        }
        for k in (0..=36).rev() {
            let (sn, cs) = (1.5 * PI * f64::from(k) / 36.0).m_sin_cos();
            c.push([6.0 * cs, 6.0 * sn]);
        }
        let ring = build::extrude(&[Polygon::simple(c)], &Frame::WORLD, 0.0, 4.0).unwrap();
        let p = pick(&ring, [0.0, 0.0, 1.0], [8.0, 0.05, 4.0]);
        assert!((p.length_mm - 4.0).abs() < 1e-9);
        assert_eq!(
            p.reason.as_deref(),
            Some("The edge ends at a curved face it does not run into smoothly.")
        );
        // edges that meet along a round are picked from the face they share
        let m = plate(30.0, 20.0, 3.0, [3.0; 4], 14);
        let p = pick(&m, [0.0, 0.0, 1.0], [15.0, 0.1, 3.0]);
        let front = pick(&m, [0.0, -1.0, 0.0], [15.0, 0.0, 2.9]).edge;
        let err = run(&m, &[front, p.ring[1].edge], fillet(0.5))
            .unwrap_err()
            .to_string();
        assert!(err.contains("edges 1 and 2 meet along a round"), "{err}");
        sound(&run(&m, &[front], fillet(0.5)).unwrap());
    }

    #[test]
    #[allow(
        clippy::cast_possible_truncation,
        reason = "rounded to f32 as the replies are"
    )]
    fn a_rounded_box_loop_with_keys_is_found_by_place_along_its_rounds() {
        let mut m = plate(30.0, 20.0, 3.0, [3.0; 4], 14);
        crate::faces::with_key_salt(Some(3), || crate::faces::base_keys(&mut m));
        // as the engine's replies give them: keyed, and rounded to f32
        let f32ed = |p: V3| p.map(|c| f64::from(c as f32));
        let edges: Vec<EdgeRef> = top_loop_of(&m, 15.0)
            .iter()
            .map(|e| {
                let k = keyed(&m, e);
                EdgeRef {
                    a: f32ed(k.a),
                    b: f32ed(k.b),
                    ..k
                }
            })
            .collect();
        assert!(edges.iter().all(|e| e.keys.is_some()));
        let r = run(&m, &edges, fillet(1.0)).unwrap();
        sound(&r);
        assert!(r.notes.is_empty());
        assert_eq!(r.refs.len(), edges.len());
        assert!(r.refs.iter().zip(&edges).all(|(f, e)| f.keys == e.keys
            && vec3::len(vec3::sub(f.a, e.a)) < 1e-5
            && vec3::len(vec3::sub(f.b, e.b)) < 1e-5));
    }

    #[test]
    fn a_round_edge_with_a_split_face_key_requires_repair() {
        let mut plate = build::cylinder(&Frame::WORLD, 10.0, 0.0, 5.0, 64);
        crate::faces::with_key_salt(Some(18), || crate::faces::base_keys(&mut plate));
        let selected = keyed(&plate, &pick(&plate, [0.0, 0.0, 1.0], [9.9, 0.0, 5.0]).edge);
        let keys = selected.keys.unwrap();
        let faces = plate.faces.as_mut().unwrap();
        let other = faces.keys.iter_mut().find(|key| !keys.contains(key)).unwrap();
        *other = keys[0];
        let error = apply(&plate, &[selected], fillet(1.0), &BooleanOptions::default())
            .unwrap_err()
            .to_string();
        assert!(error.contains("split") && error.contains("repair"), "{error}");
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

    /// a stand: a slanted back that folds 25 degrees into its rear face, and a lip in front
    fn stand() -> TriMesh {
        let mut pts = vec![
            [0.0, 0.0],
            [60.0, 0.0],
            [60.0, 10.0],
            [56.0, 10.0],
            [56.0, 5.0],
            [10.0, 5.0],
            [25.0, 45.0],
            [20.0, 47.0],
            [0.0, 5.0],
        ];
        if crate::poly2d::signed_area(&pts) < 0.0 {
            pts.reverse();
        }
        build::extrude(&[Polygon::simple(pts)], &Frame::WORLD, 0.0, 40.0).unwrap()
    }

    #[test]
    fn every_loop_edge_the_pick_takes_goes_through() {
        for m in [
            stand(),
            l_bracket(),
            wedge(20.0, 12.0, 9.0),
            plate(40.0, 30.0, 6.0, [4.0; 4], 6),
        ] {
            let mut seen: Vec<EdgeRef> = Vec::new();
            let mut gone = Vec::new();
            for t in 0..m.triangles.len() {
                let c = m.corners(m.triangles[t]);
                let at = vec3::scale(vec3::add(c[0], c[1]), 0.5);
                let Ok(p) = pick_edge(&m, u32::try_from(t).unwrap(), at) else {
                    continue;
                };
                let offered = p.ring.iter().map(|l| (l.edge, l.supported));
                for (edge, ok) in offered.chain(p.chain.iter().map(|e| (*e, p.supported))) {
                    if !ok || seen.contains(&edge) {
                        continue;
                    }
                    seen.push(edge);
                    if let Err(e) = run(&m, &[edge], chamfer(0.2)) {
                        gone.push(format!("{edge:?}: {e}"));
                    }
                }
            }
            assert!(!seen.is_empty());
            assert!(gone.is_empty(), "{gone:#?}");
        }
    }

    #[test]
    fn a_shallow_fold_is_not_offered_as_an_edge() {
        let m = stand();
        // the slanted back, picked near its middle: its loop holds the fold into the rear face
        let n = vec3::normalize([-42.0, 20.0, 0.0]).unwrap();
        let p = pick(&m, n, [10.0, 26.0, 20.0]);
        let fold = p
            .ring
            .iter()
            .find(|l| {
                let (a, b) = (l.edge.a, l.edge.b);
                a[0].abs() < 1e-9
                    && b[0].abs() < 1e-9
                    && (a[1] - 5.0).abs() < 1e-9
                    && (b[1] - 5.0).abs() < 1e-9
            })
            .expect("the fold is on the loop");
        assert!(!fold.supported);
        let err = run(&m, &[fold.edge], chamfer(0.5)).unwrap_err().to_string();
        assert!(err.contains("no sharp edge"), "{err}");
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

    #[test]
    fn runs_between_two_faces_come_back_in_one_order() {
        let m = build::cylinder(&Frame::WORLD, 6.0, 0.0, 4.0, 48);
        let f = crate::faces::recognize(&m);
        let key = |t: usize| u64::from(f.ids[t]) + 1;
        let top = m.triangles.iter().position(|&t| m.normal(t)[2] > 0.0).unwrap();
        let side = m
            .triangles
            .iter()
            .position(|&t| m.normal(t)[2].abs() < 1e-9)
            .unwrap();
        let ks = [key(top), key(side)];
        let first = runs_between(&m, &key, ks).unwrap();
        assert_eq!(first.0.len(), 48);
        for _ in 0..16 {
            assert_eq!(runs_between(&m, &key, ks).unwrap(), first);
        }
    }

    #[test]
    fn an_ellipse_rim_is_refused_in_words_and_a_round_one_is_not() {
        let ring = crate::sketch::ellipse_points([0.0, 0.0], 30.0, 16.0, 0.0);
        let m = build::extrude(&[Polygon::simple(ring)], &Frame::WORLD, 0.0, 10.0).unwrap();
        // a top triangle on the rim near the end of the width axis, picked at the rim
        let (t, at) = m
            .triangles
            .iter()
            .enumerate()
            .find_map(|(t, &tri)| {
                let c = m.corners(tri);
                let top = |p: &V3| (p[2] - 10.0).abs() < 1e-9;
                let rim: Vec<V3> = c.iter().copied().filter(|p| top(p) && p[0] > 14.0).collect();
                (c.iter().all(top) && rim.len() == 2).then(|| {
                    (
                        u32::try_from(t).unwrap(),
                        vec3::scale(vec3::add(rim[0], rim[1]), 0.5),
                    )
                })
            })
            .unwrap();
        let pick = pick_edge(&m, t, at).unwrap();
        assert!(!pick.supported);
        assert_eq!(pick.reason.as_deref(), Some(ELLIPSE_RIM));
        // its loop is the whole rim, none of it taken, and no size is offered for it
        assert!(pick.ring.len() > 4 && pick.ring.iter().all(|l| !l.supported));
        assert!(pick.loop_max_radius_mm <= 0.0 && pick.chain_max_radius_mm <= 0.0);
        for p in [fillet(1.0), chamfer(1.0)] {
            let err = run(&m, &[pick.edge], p).unwrap_err().to_string();
            assert!(err.contains("edge 1: the edge goes around an ellipse"), "{err}");
        }
        // a circle's rim still rounds
        let disc = build::extrude(
            &[Polygon::simple(crate::poly2d::circle([0.0, 0.0], 8.0, 64))],
            &Frame::WORLD,
            0.0,
            10.0,
        )
        .unwrap();
        let top = disc
            .triangles
            .iter()
            .position(|&tri| disc.corners(tri).iter().all(|p| (p[2] - 10.0).abs() < 1e-9))
            .unwrap();
        let rim = pick_edge(&disc, u32::try_from(top).unwrap(), [8.0, 0.0, 10.0]).unwrap();
        assert!(rim.supported, "{:?}", rim.reason);
        sound(&run(&disc, &[rim.edge], fillet(1.0)).unwrap());
    }
}
