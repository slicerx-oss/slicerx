// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! mesh repair
// triangle and vertex indices come from lists built in this module, and
// `TriMesh::validate` runs before any of them are used
#![allow(clippy::indexing_slicing)]

use crate::error::Result;
use crate::mesh::{self, TriMesh};
use crate::poly2d::{self, Polygon};
use crate::vec3::{self, Frame, V2, V3};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const NONE: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepairOptions {
    pub weld_tolerance_mm: Option<f64>,
    pub max_hole_edges: usize,
    pub fix_normals: bool,
    pub close_holes: bool,
}

impl Default for RepairOptions {
    fn default() -> Self {
        Self {
            weld_tolerance_mm: None,
            max_hole_edges: 64,
            fix_normals: true,
            close_holes: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepairReport {
    pub vertices_merged: usize,
    pub degenerate_removed: usize,
    pub duplicates_removed: usize,
    pub triangles_flipped: usize,
    pub holes_filled: usize,
    pub holes_left_open: usize,
    pub non_manifold_edges: usize,
    pub boundary_edges_after: usize,
    pub components: usize,
    pub watertight: bool,
    pub volume_mm3: f64,
}

pub fn repair(mesh: &TriMesh, opts: &RepairOptions) -> Result<(TriMesh, RepairReport)> {
    mesh.validate("repair")?;
    let mut report = RepairReport::default();
    let tol = opts
        .weld_tolerance_mm
        .filter(|t| t.is_finite() && *t >= 0.0)
        .unwrap_or_else(|| mesh::weld_tolerance(mesh.bounds()));
    let used_before = used_vertex_count(mesh);
    let mut m = mesh.weld(tol);
    report.vertices_merged = used_before.saturating_sub(m.positions.len());

    report.degenerate_removed = mesh.triangles.len() - m.triangles.len() + remove_degenerate(&mut m);
    report.duplicates_removed = remove_duplicates(&mut m);

    if opts.fix_normals {
        report.triangles_flipped += fix_winding(&mut m.triangles).flips;
    }
    if opts.close_holes {
        let (filled, open) = fill_holes(&mut m, opts.max_hole_edges);
        report.holes_filled = filled;
        report.holes_left_open = open;
    } else {
        report.holes_left_open = boundary_loops(&m.triangles).len();
    }
    if opts.fix_normals {
        let w = fix_winding(&mut m.triangles);
        report.triangles_flipped += w.flips;
        report.triangles_flipped += orient_shells(&mut m, &w);
    }

    let m = m.subset(&m.triangles);
    let edges = m.edge_report();
    report.non_manifold_edges = edges.non_manifold_edges;
    report.boundary_edges_after = edges.boundary_edges;
    report.watertight = edges.is_watertight();
    report.components = m.components().len();
    report.volume_mm3 = m.volume();
    Ok((m, report))
}

fn used_vertex_count(m: &TriMesh) -> usize {
    let mut used = vec![false; m.positions.len()];
    for &i in m.triangles.iter().flatten() {
        used[i as usize] = true;
    }
    used.iter().filter(|&&u| u).count()
}

fn remove_degenerate(m: &mut TriMesh) -> usize {
    let diag = m.bounds().map_or(0.0, |b| b.diagonal());
    let min_area = 1e-12 * diag * diag;
    let before = m.triangles.len();
    let positions = &m.positions;
    m.triangles.retain(|t| {
        if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
            return false;
        }
        let [a, b, c] = t.map(|i| positions[i as usize]);
        vec3::len(vec3::tri_normal(a, b, c)) * 0.5 > min_area
    });
    before - m.triangles.len()
}

fn remove_duplicates(m: &mut TriMesh) -> usize {
    let before = m.triangles.len();
    let mut seen = HashSet::with_capacity(before);
    m.triangles.retain(|t| {
        let mut k = *t;
        k.sort_unstable();
        seen.insert(k)
    });
    before - m.triangles.len()
}

struct Adjacency {
    /// triangle across each edge `k` (from corner `k` to `k + 1`), or `NONE` for boundary and non-manifold edges
    across: Vec<[u32; 3]>,
    boundary: Vec<(u32, u32, u32)>,
}

#[allow(clippy::cast_possible_truncation, reason = "triangle counts stay below 2^32")]
fn adjacency(tris: &[[u32; 3]]) -> Adjacency {
    let mut entries: Vec<(u64, u32, u8)> = Vec::with_capacity(tris.len() * 3);
    for (ti, t) in tris.iter().enumerate() {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let key = (u64::from(a.min(b)) << 32) | u64::from(a.max(b));
            entries.push((key, ti as u32, k as u8));
        }
    }
    entries.sort_unstable();
    let mut across = vec![[NONE; 3]; tris.len()];
    let mut boundary = Vec::new();
    let mut i = 0;
    while i < entries.len() {
        let mut j = i + 1;
        while j < entries.len() && entries[j].0 == entries[i].0 {
            j += 1;
        }
        match j - i {
            1 => {
                let (_, ti, k) = entries[i];
                let t = tris[ti as usize];
                boundary.push((t[k as usize], t[(k as usize + 1) % 3], ti));
            }
            2 => {
                let (_, t0, k0) = entries[i];
                let (_, t1, k1) = entries[i + 1];
                across[t0 as usize][k0 as usize] = t1;
                across[t1 as usize][k1 as usize] = t0;
            }
            _ => {}
        }
        i = j;
    }
    Adjacency { across, boundary }
}

struct Winding {
    flips: usize,
    comp: Vec<u32>,
    count: usize,
    adj: Adjacency,
}

fn fix_winding(tris: &mut [[u32; 3]]) -> Winding {
    let adj = adjacency(tris);
    let mut comp = vec![NONE; tris.len()];
    let mut count = 0usize;
    let mut flips = 0usize;
    let mut stack = Vec::new();
    // `adj.across` is from before any flip; a flip swaps corners 1 and 2
    let mut flipped = vec![false; tris.len()];
    for seed in 0..tris.len() {
        if comp[seed] != NONE {
            continue;
        }
        #[allow(
            clippy::cast_possible_truncation,
            reason = "component count is below the triangle count"
        )]
        let id = count as u32;
        count += 1;
        comp[seed] = id;
        stack.push(seed);
        while let Some(t) = stack.pop() {
            let tri = tris[t];
            let orig = if flipped[t] { [tri[0], tri[2], tri[1]] } else { tri };
            for k in 0..3 {
                let n = adj.across[t][k];
                if n == NONE || comp[n as usize] != NONE {
                    continue;
                }
                let (a, b) = (orig[k], orig[(k + 1) % 3]);
                let (a, b) = if flipped[t] { (b, a) } else { (a, b) };
                let nt = tris[n as usize];
                let same_dir = (0..3).any(|q| nt[q] == a && nt[(q + 1) % 3] == b);
                if same_dir {
                    tris[n as usize].swap(1, 2);
                    flipped[n as usize] = true;
                    flips += 1;
                }
                comp[n as usize] = id;
                stack.push(n as usize);
            }
        }
    }
    let adj = if flips > 0 { adjacency(tris) } else { adj };
    Winding {
        flips,
        comp,
        count,
        adj,
    }
}

fn boundary_loops(tris: &[[u32; 3]]) -> Vec<Vec<u32>> {
    let adj = adjacency(tris);
    loops_from(&adj.boundary)
}

fn loops_from(boundary: &[(u32, u32, u32)]) -> Vec<Vec<u32>> {
    let mut out_edges: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(a, b, _) in boundary {
        out_edges.entry(a).or_default().push(b);
    }
    let mut starts: Vec<u32> = out_edges.keys().copied().collect();
    starts.sort_unstable();
    let mut loops = Vec::new();
    for s in starts {
        while out_edges.get(&s).is_some_and(|e| !e.is_empty()) {
            let mut path = vec![s];
            let mut pos = HashMap::from([(s, 0)]);
            let mut cur = s;
            while let Some(next) = out_edges.get_mut(&cur).and_then(Vec::pop) {
                if let Some(&p) = pos.get(&next) {
                    let ring = path.split_off(p + 1);
                    for v in &ring {
                        pos.remove(v);
                    }
                    if ring.len() >= 2 {
                        loops.push(std::iter::once(next).chain(ring).collect());
                    }
                } else {
                    pos.insert(next, path.len());
                    path.push(next);
                }
                cur = next;
            }
        }
    }
    loops
}

fn fill_holes(m: &mut TriMesh, max_edges: usize) -> (usize, usize) {
    let loops = boundary_loops(&m.triangles);
    let (mut filled, mut open) = (0, 0);
    for mut ring in loops {
        if ring.len() > max_edges {
            open += 1;
            continue;
        }
        ring.reverse();
        fill_loop(m, &ring);
        filled += 1;
    }
    (filled, open)
}

fn fill_loop(m: &mut TriMesh, ring: &[u32]) {
    let pts: Vec<V3> = ring.iter().map(|&i| m.positions[i as usize]).collect();
    if let Some(tris) = triangulate_ring(&pts) {
        for t in tris {
            m.triangles.push(t.map(|k| ring[k as usize]));
        }
        return;
    }
    let n = pts.len() as f64;
    let c = vec3::scale(pts.iter().fold([0.0; 3], |s, &p| vec3::add(s, p)), 1.0 / n);
    let ci = m.push_vertex(c);
    for k in 0..ring.len() {
        m.triangles.push([ring[k], ring[(k + 1) % ring.len()], ci]);
    }
}

fn triangulate_ring(pts: &[V3]) -> Option<Vec<[u32; 3]>> {
    if pts.len() == 3 {
        return Some(vec![[0, 1, 2]]);
    }
    // Newell's normal is the area vector of the ring, robust for nonplanar loops
    let mut n = [0.0; 3];
    for k in 0..pts.len() {
        let (p, q) = (pts[k], pts[(k + 1) % pts.len()]);
        n = vec3::add(n, vec3::cross(p, q));
    }
    let n = vec3::normalize(n)?;
    let centroid = vec3::scale(
        pts.iter().fold([0.0; 3], |s, &p| vec3::add(s, p)),
        1.0 / pts.len() as f64,
    );
    let frame = Frame::from_normal(centroid, n, None)?;
    let flat: Vec<V2> = pts.iter().map(|&p| frame.project(p)).collect();
    let area = poly2d::signed_area(&flat);
    if area <= 0.0 || !is_simple(&flat) {
        return None;
    }
    let tris = poly2d::triangulate(&Polygon::simple(flat.clone())).ok()?;
    let covered: f64 = tris
        .iter()
        .map(|t| poly2d::orient(flat[t[0] as usize], flat[t[1] as usize], flat[t[2] as usize]) * 0.5)
        .sum();
    let all_ccw = tris
        .iter()
        .all(|t| poly2d::orient(flat[t[0] as usize], flat[t[1] as usize], flat[t[2] as usize]) > 0.0);
    (all_ccw && (covered - area).abs() <= 1e-6 * area && tris.len() + 2 == pts.len()).then_some(tris)
}

fn is_simple(ring: &[V2]) -> bool {
    let n = ring.len();
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        for j in (i + 1)..n {
            if j == i + 1 || (i == 0 && j == n - 1) {
                continue;
            }
            let (c, d) = (ring[j], ring[(j + 1) % n]);
            let d1 = poly2d::orient(a, b, c);
            let d2 = poly2d::orient(a, b, d);
            let d3 = poly2d::orient(c, d, a);
            let d4 = poly2d::orient(c, d, b);
            if d1 * d2 <= 0.0 && d3 * d4 <= 0.0 {
                return false;
            }
        }
    }
    true
}

fn orient_shells(m: &mut TriMesh, w: &Winding) -> usize {
    let mut has_boundary = vec![false; w.count];
    for &(_, _, t) in &w.adj.boundary {
        has_boundary[w.comp[t as usize] as usize] = true;
    }
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); w.count];
    for (t, &c) in w.comp.iter().enumerate() {
        members[c as usize].push(t);
    }
    let origin = m.bounds().map_or([0.0; 3], |b| b.center());
    let closed: Vec<usize> = (0..w.count).filter(|&c| !has_boundary[c]).collect();
    let volume = |tris: &[usize]| -> f64 {
        tris.iter()
            .map(|&t| {
                let [a, b, c] = m.corners(m.triangles[t]).map(|p| vec3::sub(p, origin));
                vec3::dot(a, vec3::cross(b, c)) / 6.0
            })
            .sum()
    };
    let boxes: HashMap<usize, (V3, V3)> = closed
        .iter()
        .map(|&c| (c, shell_bounds(m, &members[c])))
        .collect();
    let mut flips = Vec::new();
    for &c in &closed {
        let v = volume(&members[c]);
        if v.abs() < 1e-12 {
            continue;
        }
        let [a, b, cc] = m.corners(m.triangles[members[c][0]]);
        let probe = vec3::scale(vec3::add(vec3::add(a, b), cc), 1.0 / 3.0);
        let depth = closed
            .iter()
            .filter(|&&d| d != c && inside_shell(m, &members[d], boxes[&d], probe))
            .count();
        let want_negative = depth % 2 == 1;
        if (v < 0.0) != want_negative {
            flips.push(c);
        }
    }
    let mut n = 0;
    for c in flips {
        for &t in &members[c] {
            m.triangles[t].swap(1, 2);
            n += 1;
        }
    }
    n
}

fn shell_bounds(m: &TriMesh, tris: &[usize]) -> (V3, V3) {
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for &t in tris {
        for p in m.corners(m.triangles[t]) {
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
    }
    (lo, hi)
}

fn inside_shell(m: &TriMesh, tris: &[usize], (lo, hi): (V3, V3), p: V3) -> bool {
    const DIR: V3 = [0.577_350_269, 0.312_147_9, 0.754_878_1];
    let (mut t0, mut t1) = (0.0f64, f64::INFINITY);
    for k in 0..3 {
        let (o, d) = (p[k], DIR[k]);
        let (a, b) = ((lo[k] - o) / d, (hi[k] - o) / d);
        t0 = t0.max(a.min(b));
        t1 = t1.min(a.max(b));
    }
    if t0 > t1 {
        return false;
    }
    let mut hits = 0usize;
    for &t in tris {
        let [a, b, c] = m.corners(m.triangles[t]);
        let e1 = vec3::sub(b, a);
        let e2 = vec3::sub(c, a);
        let h = vec3::cross(DIR, e2);
        let det = vec3::dot(e1, h);
        if det.abs() < 1e-18 {
            continue;
        }
        let s = vec3::sub(p, a);
        let u = vec3::dot(s, h) / det;
        if !(0.0..=1.0).contains(&u) {
            continue;
        }
        let q = vec3::cross(s, e1);
        let v = vec3::dot(DIR, q) / det;
        if v < 0.0 || u + v > 1.0 {
            continue;
        }
        if vec3::dot(e2, q) / det > 1e-12 {
            hits += 1;
        }
    }
    hits % 2 == 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    fn default_repair(m: &TriMesh) -> (TriMesh, RepairReport) {
        repair(m, &RepairOptions::default()).unwrap()
    }

    #[test]
    fn flips_found_after_a_flipped_neighbor() {
        for f in 0..11 {
            let mut m = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
            m.triangles.pop();
            m.triangles[f].swap(1, 2);
            let (r, rep) = default_repair(&m);
            assert!(rep.watertight && rep.holes_filled == 1, "{f}: {rep:?}");
            assert!((r.volume() - 8000.0).abs() < 1e-6, "{f}: {}", r.volume());
        }
    }

    #[test]
    fn sphere_with_missing_triangles_is_closed() {
        let s = build::uv_sphere([0.0; 3], 10.0, 24, 36);
        let mut holed = s.clone();
        for i in [100, 101, 102, 400] {
            holed.triangles.remove(i.min(holed.triangles.len() - 1));
        }
        assert!(!holed.edge_report().is_watertight());
        let (fixed, r) = default_repair(&holed);
        assert!(r.watertight, "{r:?}");
        assert!(r.holes_filled >= 1);
        assert_eq!(r.holes_left_open, 0);
        assert!(fixed.volume() > 0.0);
        assert!((fixed.volume() - s.volume()).abs() / s.volume() < 0.05);
    }

    #[test]
    fn large_holes_stay_open_and_are_reported() {
        let s = build::uv_sphere([0.0; 3], 10.0, 24, 36);
        let mut holed = s.clone();
        for i in (0..40).rev() {
            holed.triangles.remove(200 + i);
        }
        let opts = RepairOptions {
            max_hole_edges: 6,
            ..RepairOptions::default()
        };
        let (_, r) = repair(&holed, &opts).unwrap();
        assert!(r.holes_left_open >= 1);
        assert!(!r.watertight);
    }

    #[test]
    fn flipped_cube_faces_are_made_consistent() {
        let mut c = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        for i in [0, 5, 9] {
            c.triangles[i].swap(1, 2);
        }
        assert!(!c.edge_report().is_watertight());
        let (fixed, r) = default_repair(&c);
        assert!(r.watertight);
        assert!((fixed.volume() - 1000.0).abs() < 1e-9);
        assert!(r.triangles_flipped >= 3);
    }

    #[test]
    fn inside_out_cube_faces_outward_afterwards() {
        let mut c = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        c.flip();
        let (fixed, r) = default_repair(&c);
        assert!(r.watertight);
        assert!((fixed.volume() - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn duplicate_and_degenerate_faces_are_removed() {
        let mut c = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        let dup = c.triangles[3];
        c.triangles.push(dup);
        c.triangles.push([dup[1], dup[2], dup[0]]);
        c.triangles.push([0, 0, 1]);
        let extra = c.push_vertex([5.0, 5.0, 5.0]);
        let extra2 = c.push_vertex([6.0, 6.0, 6.0]);
        let extra3 = c.push_vertex([7.0, 7.0, 7.0]);
        c.triangles.push([extra, extra2, extra3]);
        let (fixed, r) = default_repair(&c);
        assert_eq!(r.duplicates_removed, 2);
        assert_eq!(r.degenerate_removed, 2);
        assert_eq!(fixed.triangles.len(), 12);
        assert!(r.watertight);
    }

    #[test]
    fn torus_soup_welds_back_to_watertight() {
        let t = build::torus([0.0; 3], 20.0, 6.0, 40, 24);
        let mut soup = TriMesh::default();
        for &tri in &t.triangles {
            let [a, b, c] = t.corners(tri);
            soup.push_triangle(a, b, c);
        }
        let (fixed, r) = default_repair(&soup);
        assert!(r.watertight, "{r:?}");
        assert_eq!(fixed.positions.len(), t.positions.len());
        assert_eq!(r.vertices_merged, soup.positions.len() - t.positions.len());
        assert!((fixed.volume() - t.volume()).abs() < 1e-6);
        assert_eq!(r.components, 1);
    }

    #[test]
    fn three_triangles_on_one_edge_are_reported() {
        let m = TriMesh::new(
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, -1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            vec![[0, 1, 2], [0, 1, 3], [0, 1, 4]],
        );
        let (_, r) = default_repair(&m);
        assert_eq!(r.non_manifold_edges, 1);
        assert!(!r.watertight);
    }

    #[test]
    fn hollow_inner_shell_faces_inward() {
        let mut outer = build::box_mesh([0.0; 3], [30.0, 30.0, 30.0]);
        let inner = build::box_mesh([10.0; 3], [20.0, 20.0, 20.0]);
        outer.append(&inner);
        let (fixed, r) = default_repair(&outer);
        assert!(r.watertight);
        assert!(
            (fixed.volume() - (27_000.0 - 1000.0)).abs() < 1e-6,
            "{}",
            fixed.volume()
        );
        let mut both = build::box_mesh([0.0; 3], [30.0, 30.0, 30.0]);
        both.append(&build::box_mesh([10.0; 3], [20.0, 20.0, 20.0]));
        let (fixed2, _) = default_repair(&both);
        assert!((fixed2.volume() - 26_000.0).abs() < 1e-6);
    }

    #[test]
    fn json_shape_is_camel_case() {
        let r = RepairReport::default();
        let v = serde_json::to_value(r).unwrap();
        assert!(v.get("verticesMerged").is_some());
        assert!(v.get("boundaryEdgesAfter").is_some());
        let o: RepairOptions = serde_json::from_str(r#"{"maxHoleEdges": 8}"#).unwrap();
        assert_eq!(o.max_hole_edges, 8);
        assert!(o.fix_normals);
    }

    #[test]
    #[ignore = "timing, run with --release -- --ignored --nocapture"]
    fn timing_on_30k_torus() {
        let t = build::torus([0.0; 3], 20.0, 6.0, 150, 100);
        let mut holed = t.clone();
        let mut seed = 12345u64;
        for _ in 0..50 {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let i = (seed >> 33) as usize % holed.triangles.len();
            holed.triangles.remove(i);
        }
        let start = std::time::Instant::now();
        let (fixed, r) = default_repair(&holed);
        println!("repair 30k torus: {:?}, {r:?}", start.elapsed());
        assert!(fixed.volume() > 0.0);
    }
}
