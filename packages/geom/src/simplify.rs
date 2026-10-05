// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! mesh simplification by quadric error edge collapse (Garland and Heckbert)
// indices come from the mesh and the work arrays built from it
#![allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::too_many_lines
)]

use crate::error::{Error, Result};
use crate::mesh::TriMesh;
use crate::vec3::{self, V3};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimplifyOptions {
    pub target_ratio: Option<f64>,
    pub target_triangles: Option<usize>,
    pub max_error_mm: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimplifyReport {
    pub triangles_before: usize,
    pub triangles_after: usize,
    pub collapses: usize,
    pub max_error_mm: f64,
}

type Quadric = [f64; 10];

fn plane_quadric(n: V3, d: f64, w: f64) -> Quadric {
    let (a, b, c) = (n[0], n[1], n[2]);
    [
        w * a * a,
        w * a * b,
        w * a * c,
        w * a * d,
        w * b * b,
        w * b * c,
        w * b * d,
        w * c * c,
        w * c * d,
        w * d * d,
    ]
}

fn add(q: &mut Quadric, o: &Quadric) {
    for (x, y) in q.iter_mut().zip(o) {
        *x += y;
    }
}

fn eval(q: &Quadric, p: V3) -> f64 {
    let (x, y, z) = (p[0], p[1], p[2]);
    (q[0] * x * x + 2.0 * q[1] * x * y + 2.0 * q[2] * x * z + 2.0 * q[3] * x)
        + (q[4] * y * y + 2.0 * q[5] * y * z + 2.0 * q[6] * y)
        + (q[7] * z * z + 2.0 * q[8] * z)
        + q[9]
}

fn optimum(q: &Quadric) -> Option<V3> {
    let (a, b, c) = ([q[0], q[1], q[2]], [q[1], q[4], q[5]], [q[2], q[5], q[7]]);
    let det = vec3::dot(a, vec3::cross(b, c));
    let scale = q[0].abs() + q[4].abs() + q[7].abs();
    if det.abs() < 1e-9 * scale * scale * scale.max(1e-30) {
        return None;
    }
    let rhs = [-q[3], -q[6], -q[8]];
    // Cramer's rule
    let x = vec3::dot(rhs, vec3::cross(b, c)) / det;
    let y = vec3::dot(a, vec3::cross(rhs, c)) / det;
    let z = vec3::dot(a, vec3::cross(b, rhs)) / det;
    let p = [x, y, z];
    p.iter().all(|v| v.is_finite()).then_some(p)
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Entry {
    cost: u64,
    a: u32,
    b: u32,
    va: u32,
    vb: u32,
}

struct Work {
    pos: Vec<V3>,
    q: Vec<Quadric>,
    tris: Vec<[u32; 3]>,
    alive: Vec<bool>,
    vtris: Vec<Vec<u32>>,
    boundary: Vec<bool>,
    version: Vec<u32>,
    dead: Vec<bool>,
}

impl Work {
    fn neighbors(&self, v: u32) -> Vec<u32> {
        let mut out: Vec<u32> = self.vtris[v as usize]
            .iter()
            .flat_map(|&t| self.tris[t as usize])
            .filter(|&w| w != v)
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    fn shared(&self, a: u32, b: u32) -> Vec<u32> {
        self.vtris[a as usize]
            .iter()
            .copied()
            .filter(|&t| self.tris[t as usize].contains(&b))
            .collect()
    }

    fn normal(&self, t: [u32; 3], moved: Option<(u32, V3)>) -> V3 {
        let p = |i: u32| match moved {
            Some((m, at)) if m == i => at,
            _ => self.pos[i as usize],
        };
        vec3::tri_normal(p(t[0]), p(t[1]), p(t[2]))
    }

    fn plan(&self, a: u32, b: u32) -> Option<(f64, V3)> {
        let shared = self.shared(a, b);
        let boundary_edge = shared.len() == 1;
        if shared.is_empty() || shared.len() > 2 {
            return None;
        }
        let (ba, bb) = (self.boundary[a as usize], self.boundary[b as usize]);
        if ba && bb && !boundary_edge {
            return None;
        }
        // link condition: the only vertices next to both are the tips of the
        // faces on the edge
        let (na, nb) = (self.neighbors(a), self.neighbors(b));
        let common = na.iter().filter(|v| nb.binary_search(v).is_ok()).count();
        if common != shared.len() {
            return None;
        }
        let mut q = self.q[a as usize];
        add(&mut q, &self.q[b as usize]);
        let (pa, pb) = (self.pos[a as usize], self.pos[b as usize]);
        let mid = vec3::scale(vec3::add(pa, pb), 0.5);
        let mut cands: Vec<V3> = if ba && !bb {
            vec![pa]
        } else if bb && !ba {
            vec![pb]
        } else if ba && bb {
            vec![pa, pb, mid]
        } else {
            let mut c = vec![pa, pb, mid];
            c.extend(optimum(&q));
            c
        };
        cands.retain(|&p| self.keeps_faces(a, b, p));
        cands
            .into_iter()
            .map(|p| (eval(&q, p).max(0.0), p))
            .min_by(|x, y| x.0.total_cmp(&y.0))
    }

    fn keeps_faces(&self, a: u32, b: u32, p: V3) -> bool {
        for (v, other) in [(a, b), (b, a)] {
            for &t in &self.vtris[v as usize] {
                let tri = self.tris[t as usize];
                if tri.contains(&other) {
                    continue;
                }
                let before = self.normal(tri, None);
                let after = self.normal(tri, Some((v, p)));
                let (lb, la) = (vec3::len(before), vec3::len(after));
                if la < 1e-12 * lb.max(1e-30) || vec3::dot(before, after) <= 0.1 * lb * la {
                    return false;
                }
            }
        }
        true
    }

    fn push(&self, heap: &mut BinaryHeap<Reverse<Entry>>, a: u32, b: u32) {
        if let Some((cost, _)) = self.plan(a, b) {
            heap.push(Reverse(Entry {
                cost: cost.to_bits(),
                a,
                b,
                va: self.version[a as usize],
                vb: self.version[b as usize],
            }));
        }
    }
}

pub fn simplify(mesh: &TriMesh, opts: &SimplifyOptions) -> Result<(TriMesh, SimplifyReport)> {
    mesh.validate("simplify")?;
    if opts.target_ratio.is_some_and(|r| !(0.0..=1.0).contains(&r)) {
        return Err(Error::invalid("targetRatio", "out of range"));
    }
    if opts.max_error_mm.is_some_and(|e| !(e.is_finite() && e >= 0.0)) {
        return Err(Error::invalid("maxErrorMm", "out of range"));
    }
    let base = mesh.welded();
    let before = base.triangles.len();
    let mut goal = before;
    if let Some(r) = opts.target_ratio {
        goal = goal.min((before as f64 * r).ceil() as usize);
    }
    if let Some(n) = opts.target_triangles {
        goal = goal.min(n);
    }
    let max_cost = opts.max_error_mm.map_or(f64::INFINITY, |e| e * e);

    let n = base.positions.len();
    let tris: Vec<[u32; 3]> = base
        .triangles
        .iter()
        .copied()
        .filter(|t| t[0] != t[1] && t[1] != t[2] && t[0] != t[2])
        .collect();
    let mut w = Work {
        pos: base.positions.clone(),
        q: vec![[0.0; 10]; n],
        alive: vec![true; tris.len()],
        tris,
        vtris: vec![Vec::new(); n],
        boundary: vec![false; n],
        version: vec![0; n],
        dead: vec![false; n],
    };
    let mut edge_faces: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
    for (i, t) in w.tris.iter().enumerate() {
        let id = i as u32;
        let nrm = vec3::tri_normal(
            base.positions[t[0] as usize],
            base.positions[t[1] as usize],
            base.positions[t[2] as usize],
        );
        let l = vec3::len(nrm);
        for k in 0..3 {
            w.vtris[t[k] as usize].push(id);
            let (x, y) = (t[k], t[(k + 1) % 3]);
            edge_faces.entry((x.min(y), x.max(y))).or_default().push(id);
        }
        if l > 1e-15 {
            let u = vec3::scale(nrm, 1.0 / l);
            let d = -vec3::dot(u, base.positions[t[0] as usize]);
            let quad = plane_quadric(u, d, 1.0);
            for &v in t {
                add(&mut w.q[v as usize], &quad);
            }
        }
    }
    for (&(x, y), fs) in &edge_faces {
        if fs.len() != 1 {
            continue;
        }
        w.boundary[x as usize] = true;
        w.boundary[y as usize] = true;
        let t = w.tris[fs[0] as usize];
        let nrm = vec3::normalize(vec3::tri_normal(
            base.positions[t[0] as usize],
            base.positions[t[1] as usize],
            base.positions[t[2] as usize],
        ));
        let e = vec3::sub(base.positions[y as usize], base.positions[x as usize]);
        if let Some(side) = nrm.and_then(|nn| vec3::normalize(vec3::cross(e, nn))) {
            let d = -vec3::dot(side, base.positions[x as usize]);
            let quad = plane_quadric(side, d, 1000.0);
            add(&mut w.q[x as usize], &quad);
            add(&mut w.q[y as usize], &quad);
        }
    }

    let mut heap = BinaryHeap::new();
    for &(x, y) in edge_faces.keys() {
        w.push(&mut heap, x, y);
    }
    let mut alive_count = w.tris.len();
    let (mut collapses, mut worst) = (0usize, 0.0_f64);
    while alive_count > goal {
        let Some(Reverse(e)) = heap.pop() else { break };
        let (a, b) = (e.a, e.b);
        if w.dead[a as usize]
            || w.dead[b as usize]
            || w.version[a as usize] != e.va
            || w.version[b as usize] != e.vb
        {
            continue;
        }
        let Some((cost, at)) = w.plan(a, b) else { continue };
        if cost > f64::from_bits(e.cost) * (1.0 + 1e-9) + 1e-18 {
            heap.push(Reverse(Entry {
                cost: cost.to_bits(),
                ..e
            }));
            continue;
        }
        if cost > max_cost {
            break;
        }
        let shared = w.shared(a, b);
        for &t in &shared {
            w.alive[t as usize] = false;
        }
        alive_count -= shared.len();
        for t in std::mem::take(&mut w.vtris[b as usize]) {
            if !w.alive[t as usize] {
                continue;
            }
            for v in &mut w.tris[t as usize] {
                if *v == b {
                    *v = a;
                }
            }
            w.vtris[a as usize].push(t);
        }
        let (alive, vt) = (&w.alive, &mut w.vtris[a as usize]);
        vt.retain(|&t| alive[t as usize]);
        vt.sort_unstable();
        vt.dedup();
        w.pos[a as usize] = at;
        let qb = w.q[b as usize];
        add(&mut w.q[a as usize], &qb);
        w.boundary[a as usize] |= w.boundary[b as usize];
        w.dead[b as usize] = true;
        w.version[a as usize] += 1;
        collapses += 1;
        worst = worst.max(cost);
        for nb in w.neighbors(a) {
            w.push(&mut heap, a.min(nb), a.max(nb));
        }
    }

    let kept: Vec<[u32; 3]> = w
        .tris
        .iter()
        .zip(&w.alive)
        .filter(|(_, a)| **a)
        .map(|(t, _)| *t)
        .collect();
    let m = TriMesh::new(w.pos, Vec::new()).subset(&kept);
    let report = SimplifyReport {
        triangles_before: before,
        triangles_after: m.triangles.len(),
        collapses,
        max_error_mm: worst.sqrt(),
    };
    Ok((m, report))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    fn max_radius_error(m: &TriMesh, center: V3, r: f64) -> f64 {
        m.positions
            .iter()
            .map(|p| (vec3::len(vec3::sub(*p, center)) - r).abs())
            .fold(0.0, f64::max)
    }

    #[test]
    fn sphere_keeps_its_shape_at_a_fifth_of_the_triangles() {
        let s = build::uv_sphere([0.0, 0.0, 15.0], 15.0, 60, 100);
        let (m, r) = simplify(
            &s,
            &SimplifyOptions {
                target_ratio: Some(0.2),
                ..SimplifyOptions::default()
            },
        )
        .unwrap();
        assert!(
            r.triangles_after <= (r.triangles_before as f64 * 0.21) as usize,
            "{r:?}"
        );
        assert!(r.triangles_after > r.triangles_before / 10, "{r:?}");
        assert!(m.edge_report().is_watertight(), "{:?}", m.edge_report());
        assert!((m.volume() - s.volume()).abs() / s.volume() < 0.03);
        assert!(max_radius_error(&m, [0.0, 0.0, 15.0], 15.0) < 0.6);
        assert!(r.max_error_mm < 0.6 && r.collapses > 0);
    }

    #[test]
    fn error_limit_stops_early_and_zero_keeps_a_box() {
        let s = build::uv_sphere([0.0; 3], 10.0, 40, 60);
        let (_, loose) = simplify(
            &s,
            &SimplifyOptions {
                target_ratio: Some(0.05),
                ..SimplifyOptions::default()
            },
        )
        .unwrap();
        let (m, tight) = simplify(
            &s,
            &SimplifyOptions {
                target_ratio: Some(0.05),
                max_error_mm: Some(0.02),
                ..SimplifyOptions::default()
            },
        )
        .unwrap();
        assert!(tight.triangles_after > loose.triangles_after);
        assert!(tight.max_error_mm <= 0.02 + 1e-9, "{tight:?}");
        assert!(m.edge_report().is_watertight());
        let b = build::box_mesh([0.0; 3], [10.0, 20.0, 30.0]);
        let (kept, r) = simplify(
            &b,
            &SimplifyOptions {
                target_ratio: Some(0.1),
                max_error_mm: Some(0.01),
                ..SimplifyOptions::default()
            },
        )
        .unwrap();
        assert_eq!(kept.triangles.len(), 12, "{r:?}");
        assert!((kept.volume() - 6000.0).abs() < 1e-6);
    }

    #[test]
    fn open_meshes_keep_their_rim_and_no_options_change_nothing() {
        let mut s = build::uv_sphere([0.0; 3], 10.0, 30, 40);
        let before = s.triangles.len();
        s.triangles
            .retain(|t| t.iter().any(|&i| s.positions[i as usize][2] < 9.0));
        let open = s.triangles.len();
        assert!(open < before);
        let rim_before = s.edge_report().boundary_edges;
        assert!(rim_before > 0);
        let (m, _) = simplify(
            &s,
            &SimplifyOptions {
                target_ratio: Some(0.3),
                ..SimplifyOptions::default()
            },
        )
        .unwrap();
        let e = m.edge_report();
        assert!(e.non_manifold_edges == 0 && e.flipped_edges == 0, "{e:?}");
        assert!(e.boundary_edges > 0);
        let (same, r) = simplify(&s, &SimplifyOptions::default()).unwrap();
        assert_eq!(same.triangles.len(), open);
        assert_eq!(r.collapses, 0);
        assert!(
            simplify(
                &s,
                &SimplifyOptions {
                    target_ratio: Some(2.0),
                    ..SimplifyOptions::default()
                }
            )
            .is_err()
        );
    }
}
