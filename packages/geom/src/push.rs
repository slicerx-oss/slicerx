// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! push and pull

use crate::boolean::{self, BoolOp, BooleanOptions};
use crate::build;
use crate::error::{Error, Result};
use crate::face::{self, ExtrudeReport, FaceFrame, Operation};
use crate::mesh::TriMesh;
use crate::poly2d::{self, Polygon};
use crate::vec3::{self, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// the prism reaches this far past the face, so the boolean never meets two coincident faces
const OVERLAP_MM: f64 = 0.01;
const MIN_AREA_MM2: f64 = 1e-6;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub frame: FaceFrame,
    pub outline: Vec<Polygon>,
    pub distance_mm: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PushResult {
    pub mesh: TriMesh,
    pub tool: TriMesh,
    pub operation: Operation,
    pub report: ExtrudeReport,
    pub moved: Moved,
}

fn check_distance(d: f64) -> Result<f64> {
    if d.is_finite() && d.abs() > 1e-6 && d.abs() <= 10_000.0 {
        Ok(d)
    } else {
        Err(Error::invalid(
            "distanceMm",
            "must not be zero (at most 10000 mm)",
        ))
    }
}

fn clean(outline: &[Polygon]) -> Result<Vec<Polygon>> {
    let rings: Vec<Vec<_>> = outline
        .iter()
        .flat_map(|p| std::iter::once(p.outer.clone()).chain(p.holes.iter().cloned()))
        .collect();
    if rings
        .iter()
        .flatten()
        .any(|p| !(p[0].is_finite() && p[1].is_finite()))
    {
        return Err(Error::invalid("outline", "must be finite"));
    }
    let polys = poly2d::fill_nonzero(rings, 1e-9);
    let area: f64 = polys.iter().map(Polygon::area).sum();
    if polys.is_empty() || area < MIN_AREA_MM2 {
        return Err(Error::invalid("face", "the face is too small to move"));
    }
    Ok(polys)
}

pub fn preview(frame: &FaceFrame, outline: &[Polygon], distance_mm: f64) -> Result<(TriMesh, Operation)> {
    let d = check_distance(distance_mm)?;
    let f = frame.checked()?;
    let polys = clean(outline)?;
    if d > 0.0 {
        Ok((build::extrude(&polys, &f, -OVERLAP_MM, d)?, Operation::Join))
    } else {
        Ok((build::extrude(&polys, &f, d, OVERLAP_MM)?, Operation::Cut))
    }
}

/// the prism's walls go through the face's own corners: the outline went through the face frame and
/// the overlay's grid, and walls a few nanometers off the body's leave hairline flaps standing
fn on_corners(tool: &mut TriMesh, mesh: &TriMesh, region: &[u32], frame: &FaceFrame, d: f64) {
    let n = frame.normal;
    let size = mesh.bounds().map_or(1.0, |b| b.diagonal());
    let cell = (size * 1e-7).max(1e-9);
    let caps = if d > 0.0 {
        [-OVERLAP_MM, d]
    } else {
        [d, OVERLAP_MM]
    };
    let key = |p: V3| {
        #[allow(clippy::cast_possible_truncation, reason = "cells of a bounded body")]
        let k = p.map(|c| (c / cell).floor() as i64);
        k
    };
    let mut grid: HashMap<[i64; 3], Vec<V3>> = HashMap::new();
    for &t in region {
        let Some(&tri) = mesh.triangles.get(t as usize) else {
            continue;
        };
        for p in mesh.corners(tri) {
            let list = grid.entry(key(p)).or_default();
            if !list.contains(&p) {
                list.push(p);
            }
        }
    }
    tool.map_positions(|v| {
        let along = vec3::dot(vec3::sub(v, frame.origin), n);
        let h = if (along - caps[0]).abs() < (along - caps[1]).abs() {
            caps[0]
        } else {
            caps[1]
        };
        let base = vec3::sub(v, vec3::scale(n, along));
        let k = key(base);
        let mut best: Option<(f64, V3)> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    for &q in grid.get(&[k[0] + dx, k[1] + dy, k[2] + dz]).into_iter().flatten() {
                        let dist = vec3::len(vec3::sub(q, base));
                        if dist <= cell && best.is_none_or(|(bd, _)| dist < bd) {
                            best = Some((dist, q));
                        }
                    }
                }
            }
        }
        best.map_or(v, |(_, q)| vec3::add(q, vec3::scale(n, h)))
    });
}

pub fn push_face(
    mesh: &TriMesh,
    triangle: u32,
    at: V3,
    distance_mm: f64,
    opts: &BooleanOptions,
) -> Result<PushResult> {
    check_distance(distance_mm)?;
    let pick = face::pick_face(mesh, triangle, at)?;
    let (mut tool, operation) = preview(&pick.frame, &pick.outline, distance_mm)?;
    on_corners(&mut tool, mesh, &pick.triangles, &pick.frame, distance_mm);
    let before = boolean::Solid::new(mesh)?;
    let v0 = before.volume();
    let solid = boolean::Solid::new(&tool)?;
    let op = if operation == Operation::Join {
        BoolOp::Union
    } else {
        BoolOp::Difference
    };
    let (out, mut r) = boolean::boolean_solids(&[before], &[solid], op, opts)?;
    if r.empty || out.triangles.is_empty() {
        return Err(Error::geometry("face.push", "the cut removes the whole body"));
    }
    let out = boolean::tidy(out, &mut r);
    Ok(PushResult {
        report: ExtrudeReport {
            volume_change_mm3: r.volume_mm3 - v0,
            touches: true,
            shells: r.shells,
            watertight: r.watertight,
            boolean: Some(r),
        },
        mesh: out,
        tool,
        operation,
        moved: Moved {
            frame: pick.frame,
            outline: pick.outline,
            distance_mm,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vec3;

    fn facing(m: &TriMesh, dir: V3, at_least: f64) -> (u32, V3) {
        let i = m
            .triangles
            .iter()
            .position(|&t| {
                let n = vec3::normalize(m.normal(t)).unwrap_or([0.0; 3]);
                let c = m.corners(t);
                vec3::dot(n, dir) > 0.999 && vec3::dot(c[0], dir) >= at_least - 1e-9
            })
            .unwrap();
        let c = m.corners(m.triangles[i]);
        let at = vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0);
        (u32::try_from(i).unwrap(), at)
    }

    fn push(m: &TriMesh, dir: V3, level: f64, d: f64) -> Result<PushResult> {
        let (t, at) = facing(m, dir, level);
        push_face(m, t, at, d, &BooleanOptions::default())
    }

    fn plate_with_hole() -> TriMesh {
        let plate = build::box_mesh([0.0; 3], [30.0, 20.0, 4.0]);
        let hole = build::box_mesh([10.0, 5.0, -1.0], [20.0, 15.0, 5.0]);
        boolean::boolean(&[plate], &[hole], BoolOp::Difference, &BooleanOptions::default())
            .unwrap()
            .0
    }

    #[test]
    fn a_pulled_box_is_a_box_again() {
        // the old top's corners and the tool's (0.01 mm below them) are left on the side edges: a plain box
        // still, with its six faces where they were
        let mut m = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
        m.faces = Some(crate::faces::recognize(&m));
        for d in [5.0, 10.0] {
            let r = push(&m, [0.0, 0.0, 1.0], 20.0, d).unwrap();
            assert_eq!(r.mesh.triangles.len(), 12, "pull {d}");
            assert!(r.mesh.edge_report().is_watertight());
            assert!((r.mesh.volume() - 400.0 * (20.0 + d)).abs() < 1e-6);
            let f = r.mesh.faces.as_ref().unwrap();
            let mut per_face = vec![0; f.table.len()];
            for &i in &f.ids {
                per_face[i as usize] += 1;
            }
            assert_eq!(per_face, vec![2; 6], "pull {d}");
        }
    }

    #[test]
    fn pull_and_push_a_box_top() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let r = push(&m, [0.0, 0.0, 1.0], 5.0, 3.0).unwrap();
        assert!(r.report.watertight && r.report.shells == 1);
        assert!(
            (r.mesh.volume() - 20.0 * 10.0 * 8.0).abs() < 1e-6,
            "{}",
            r.mesh.volume()
        );
        assert!((r.report.volume_change_mm3 - 600.0).abs() < 1e-6);
        let b = r.mesh.bounds().unwrap();
        assert!((b.max[2] - 8.0).abs() < 1e-9);
        let r = push(&m, [0.0, 0.0, 1.0], 5.0, -2.0).unwrap();
        assert!((r.mesh.volume() - 600.0).abs() < 1e-6);
        assert_eq!(r.operation, Operation::Cut);
        let r = push(&m, [1.0, 0.0, 0.0], 20.0, 5.0).unwrap();
        assert!((r.mesh.bounds().unwrap().max[0] - 25.0).abs() < 1e-9);
    }

    #[test]
    fn face_with_a_hole_keeps_the_hole() {
        let m = plate_with_hole();
        let r = push(&m, [0.0, 0.0, 1.0], 4.0, 6.0).unwrap();
        assert!(r.report.watertight && r.report.shells == 1);
        assert!(
            (r.mesh.volume() - (600.0 - 100.0) * 10.0).abs() < 1e-5,
            "{}",
            r.mesh.volume()
        );
        assert_eq!(r.moved.outline.len(), 1);
        assert_eq!(r.moved.outline[0].holes.len(), 1);
    }

    #[test]
    fn push_through_a_wall_makes_a_hole() {
        let outer = build::box_mesh([0.0; 3], [20.0, 20.0, 10.0]);
        let inner = build::box_mesh([2.0, 2.0, 2.0], [18.0, 18.0, 11.0]);
        let cup = boolean::boolean(&[outer], &[inner], BoolOp::Difference, &BooleanOptions::default())
            .unwrap()
            .0;
        let (t, _) = facing(&cup, [1.0, 0.0, 0.0], 20.0);
        let r = push_face(&cup, t, [20.0, 10.0, 5.0], -2.5, &BooleanOptions::default()).unwrap();
        assert!(r.report.watertight && r.report.shells == 1);
        let removed = 400.0 + 0.5 * 40.0 + 0.5 * 32.0;
        assert!(
            (r.report.volume_change_mm3 + removed).abs() < 1e-5,
            "{:?}",
            r.report
        );
        assert!((r.mesh.bounds().unwrap().max[0] - 17.5).abs() < 1e-9);
    }

    #[test]
    fn pushing_a_floor_by_its_thickness_opens_the_bottom() {
        let outer = build::box_mesh([0.0; 3], [20.0, 20.0, 10.0]);
        let inner = build::box_mesh([2.0, 2.0, 2.0], [18.0, 18.0, 11.0]);
        let cup = boolean::boolean(&[outer], &[inner], BoolOp::Difference, &BooleanOptions::default())
            .unwrap()
            .0;
        let floor = cup
            .triangles
            .iter()
            .position(|&t| cup.corners(t).iter().all(|p| (p[2] - 2.0).abs() < 1e-9) && cup.normal(t)[2] > 0.0)
            .unwrap();
        let c = cup.corners(cup.triangles[floor]);
        let at = vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0);
        let r = push_face(
            &cup,
            u32::try_from(floor).unwrap(),
            at,
            -2.0,
            &BooleanOptions::default(),
        )
        .unwrap();
        assert!(r.report.watertight);
        let area_at_bottom = |up: bool| -> f64 {
            r.mesh
                .triangles
                .iter()
                .map(|&t| r.mesh.corners(t))
                .filter(|c| c.iter().all(|p| p[2].abs() < 1e-9))
                .map(|c| vec3::tri_normal(c[0], c[1], c[2]))
                .filter(|n| (n[2] > 0.0) == up)
                .map(|n| vec3::len(n) * 0.5)
                .sum()
        };
        // The bottom keeps only its rim, and no skin of no thickness covers the opening (the face shape tool's
        // cut needed a fix for this; the push prism's walls on the face's own corners already open it).
        assert!(
            (area_at_bottom(false) - (400.0 - 256.0)).abs() < 1e-6,
            "{}",
            area_at_bottom(false)
        );
        assert!(area_at_bottom(true) < 1e-9, "{}", area_at_bottom(true));
    }

    #[test]
    fn coplanar_region_of_two_joined_blocks_moves_as_one() {
        let a = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let b = build::box_mesh([0.0, 10.0, 0.0], [10.0, 30.0, 5.0]);
        let l = boolean::boolean(&[a], &[b], BoolOp::Union, &BooleanOptions::default())
            .unwrap()
            .0;
        let r = push(&l, [0.0, 0.0, 1.0], 5.0, 2.0).unwrap();
        let area = 200.0 + 200.0;
        assert!(
            (r.report.volume_change_mm3 - area * 2.0).abs() < 1e-5,
            "{:?}",
            r.report
        );
        assert_eq!(r.report.shells, 1);
    }

    #[test]
    fn degenerate_input_fails_in_words() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        for d in [0.0, f64::NAN, f64::INFINITY, 1e-9, 20_000.0] {
            let e = push(&m, [0.0, 0.0, 1.0], 5.0, d).unwrap_err().to_string();
            assert!(e.contains("distanceMm"), "{e}");
        }
        let e = push(&m, [0.0, 0.0, 1.0], 5.0, -50.0).unwrap_err().to_string();
        assert!(e.contains("removes the whole body"), "{e}");
        assert!(push(&m, [0.0, 0.0, 1.0], 5.0, -5.0).is_err());
        let tiny = build::box_mesh([0.0; 3], [0.01, 0.01, 0.01]);
        let r = push(&tiny, [0.0, 0.0, 1.0], 0.01, 0.005).unwrap();
        assert!(r.report.watertight);
        let frame = FaceFrame::bed([0.0, 0.0]);
        let sq = Polygon::simple(poly2d::rect([-1.0, -1.0], [1.0, 1.0]));
        let (tool, op) = preview(&frame, &[sq], -2.0).unwrap();
        assert_eq!(op, Operation::Cut);
        assert!((tool.volume() - 4.0 * 2.01).abs() < 1e-9);
        assert!(preview(&frame, &[], 1.0).is_err());
        let degenerate = Polygon::simple(vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]);
        assert!(preview(&frame, &[degenerate], 1.0).is_err());
    }

    #[test]
    fn random_pushes_stay_watertight() {
        let m = plate_with_hole();
        let mut seed = 12_345u64;
        let lcg = |s: u64| s.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        for _ in 0..24 {
            seed = lcg(seed);
            let t = usize::try_from(seed >> 33).unwrap() % m.triangles.len();
            seed = lcg(seed);
            let d = ((seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5) * 12.0;
            let c = m.corners(m.triangles[t]);
            let at = vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0);
            match push_face(&m, u32::try_from(t).unwrap(), at, d, &BooleanOptions::default()) {
                Ok(r) => assert!(
                    r.report.watertight && r.mesh.edge_report().is_watertight(),
                    "t {t} d {d}"
                ),
                Err(e) => {
                    let s = e.to_string();
                    assert!(
                        s.contains("whole body") || s.contains("distanceMm"),
                        "t {t} d {d}: {s}"
                    );
                }
            }
        }
    }

    // a push on a face beside a fillet or chamfer: the history runs the push on the body before the
    // round and rounds the moved edge again (docs/cad-history.md), so these run the ops in that order

    use crate::edge::{self, EdgeRef, Profile};
    use crate::measure::Topology;

    const SLIVER_MM: f64 = 0.05;

    fn moved(a: V3, b: V3, face: V3) -> EdgeRef {
        EdgeRef {
            a,
            b,
            face,
            moved: true,
            center: None,
            keys: None,
        }
    }

    fn round(r: f64) -> Profile {
        Profile::Fillet {
            radius: r,
            tolerance: edge::DEFAULT_TOLERANCE_MM,
        }
    }

    fn bevel(d: f64) -> Profile {
        Profile::Chamfer { d1: d, d2: d }
    }

    fn finish(m: &TriMesh, edges: &[EdgeRef], p: Profile) -> TriMesh {
        let r = edge::apply(m, edges, p, &BooleanOptions::default()).unwrap();
        assert!(r.report.watertight && r.report.shells == 1, "{:?}", r.report);
        r.mesh
    }

    /// flat faces narrower than `below` (twice the area over the perimeter)
    fn slivers(m: &TriMesh, below: f64) -> usize {
        let topo = Topology::new(m);
        let mut seen = vec![false; m.triangles.len()];
        let mut thin = 0;
        for t in 0..m.triangles.len() {
            if seen[t] {
                continue;
            }
            let region = topo.flat_region(u32::try_from(t).unwrap());
            let mut area = 0.0;
            for &r in &region {
                seen[r as usize] = true;
                let [a, b, c] = topo.corners(r);
                area += vec3::len(vec3::tri_normal(a, b, c)) * 0.5;
            }
            let rim: f64 = topo
                .region_boundary(&region)
                .iter()
                .map(|&(a, b)| vec3::len(vec3::sub(b, a)))
                .sum();
            if area > 0.0 && 2.0 * area / rim < below {
                thin += 1;
            }
        }
        thin
    }

    fn sound(m: &TriMesh) {
        assert!(m.edge_report().is_watertight(), "{:?}", m.edge_report());
        assert_eq!(m.components().len(), 1);
        assert_eq!(slivers(m, SLIVER_MM), 0, "slivers below {SLIVER_MM} mm");
    }

    fn highest(m: &TriMesh) -> f64 {
        m.positions.iter().map(|p| p[2]).fold(f64::NEG_INFINITY, f64::max)
    }

    fn same_volume(m: &TriMesh, reference: &TriMesh) {
        assert!(
            (m.volume() - reference.volume()).abs() < 1e-6,
            "{} vs {}",
            m.volume(),
            reference.volume()
        );
        let (b, r) = (m.bounds().unwrap(), reference.bounds().unwrap());
        for k in 0..3 {
            assert!((b.min[k] - r.min[k]).abs() < 1e-9 && (b.max[k] - r.max[k]).abs() < 1e-9);
        }
    }

    /// pushes the flat face holding `at`, facing `n`
    fn push_at(m: &TriMesh, at: V3, n: V3, d: f64) -> PushResult {
        let t = m
            .triangles
            .iter()
            .position(|&t| {
                let c = m.corners(t);
                let tn = vec3::normalize(m.normal(t)).unwrap_or([0.0; 3]);
                let inside = (0..3).all(|j| {
                    let e = vec3::sub(c[(j + 1) % 3], c[j]);
                    vec3::dot(vec3::cross(e, vec3::sub(at, c[j])), tn) >= -1e-9
                });
                vec3::dot(tn, n) > 0.999 && vec3::dot(vec3::sub(at, c[0]), tn).abs() < 1e-9 && inside
            })
            .unwrap();
        push_face(m, u32::try_from(t).unwrap(), at, d, &BooleanOptions::default()).unwrap()
    }

    const UP: V3 = [0.0, 0.0, 1.0];
    const FRONT: V3 = [0.0, -1.0, 0.0];

    fn block() -> TriMesh {
        build::box_mesh([0.0; 3], [30.0, 20.0, 10.0])
    }

    /// the top front edge of a block whose top is at `z` and front at `y`
    fn top_front(y: f64, z: f64) -> EdgeRef {
        moved([0.0, y, z], [30.0, y, z], UP)
    }

    #[test]
    fn a_fillet_left_in_place_stands_as_a_lip() {
        // the old way round: the push moves only the flat part of the top
        let rounded = finish(&block(), &[top_front(0.0, 10.0)], round(2.0));
        let r = push_at(&rounded, [15.0, 10.0, 10.0], UP, -3.0);
        assert!((highest(&r.mesh) - 10.0).abs() < 1e-9, "the lip is gone");
    }

    #[test]
    fn push_in_rounds_the_moved_edge() {
        let r = push_at(&block(), [15.0, 10.0, 10.0], UP, -3.0);
        let m = finish(&r.mesh, &[top_front(0.0, 7.0)], round(2.0));
        sound(&m);
        assert!((highest(&m) - 7.0).abs() < 1e-9);
        let reference = finish(
            &build::box_mesh([0.0; 3], [30.0, 20.0, 7.0]),
            &[top_front(0.0, 7.0)],
            round(2.0),
        );
        same_volume(&m, &reference);
        // the same steps give the same bytes
        let again = finish(
            &push_at(&block(), [15.0, 10.0, 10.0], UP, -3.0).mesh,
            &[top_front(0.0, 7.0)],
            round(2.0),
        );
        assert_eq!(m, again);
    }

    #[test]
    fn pull_out_rounds_the_moved_edge() {
        let r = push_at(&block(), [15.0, 10.0, 10.0], UP, 4.0);
        let m = finish(&r.mesh, &[top_front(0.0, 14.0)], round(2.0));
        sound(&m);
        let reference = finish(
            &build::box_mesh([0.0; 3], [30.0, 20.0, 14.0]),
            &[top_front(0.0, 14.0)],
            round(2.0),
        );
        same_volume(&m, &reference);
    }

    #[test]
    fn faces_on_both_sides_of_the_edge_move() {
        let top = push_at(&block(), [15.0, 10.0, 10.0], UP, -3.0);
        let front = push_at(&top.mesh, [15.0, 0.0, 3.0], FRONT, -2.0);
        let m = finish(&front.mesh, &[top_front(2.0, 7.0)], round(2.0));
        sound(&m);
        let reference = finish(
            &build::box_mesh([0.0, 2.0, 0.0], [30.0, 20.0, 7.0]),
            &[top_front(2.0, 7.0)],
            round(2.0),
        );
        same_volume(&m, &reference);
    }

    #[test]
    fn a_chamfer_follows_like_a_fillet() {
        let r = push_at(&block(), [15.0, 10.0, 10.0], UP, -3.0);
        let m = finish(&r.mesh, &[top_front(0.0, 7.0)], bevel(2.0));
        sound(&m);
        assert!(
            (m.volume() - (30.0 * 20.0 * 7.0 - 30.0 * 2.0)).abs() < 1e-6,
            "{}",
            m.volume()
        );
        let rounded = finish(&block(), &[top_front(0.0, 10.0)], bevel(2.0));
        let lip = push_at(&rounded, [15.0, 10.0, 10.0], UP, -3.0);
        assert!((highest(&lip.mesh) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn a_round_on_another_edge_needs_nothing() {
        // the round is on an edge the pushed face does not bound, or it only ends on that face:
        // pushing the rounded body as it is gives the block that was never pushed, rounded
        let low = build::box_mesh([0.0; 3], [30.0, 20.0, 7.0]);
        let bottom = moved([0.0, 0.0, 0.0], [30.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
        let rounded = finish(&block(), &[bottom], round(2.0));
        let r = push_at(&rounded, [15.0, 10.0, 10.0], UP, -3.0);
        sound(&r.mesh);
        same_volume(&r.mesh, &finish(&low, &[bottom], round(2.0)));
        let corner = |z: f64| moved([0.0, 0.0, 0.0], [0.0, 0.0, z], FRONT);
        let rounded = finish(&block(), &[corner(10.0)], round(2.0));
        let r = push_at(&rounded, [15.0, 10.0, 10.0], UP, -3.0);
        sound(&r.mesh);
        same_volume(&r.mesh, &finish(&low, &[corner(7.0)], round(2.0)));
    }

    fn pocketed() -> TriMesh {
        let plate = build::box_mesh([0.0; 3], [40.0, 30.0, 6.0]);
        let pocket = build::box_mesh([10.0, 10.0, 2.0], [30.0, 20.0, 7.0]);
        boolean::boolean(
            &[plate],
            &[pocket],
            BoolOp::Difference,
            &BooleanOptions::default(),
        )
        .unwrap()
        .0
    }

    #[test]
    fn a_pocket_pushed_through_leaves_no_ledge() {
        let floor = [
            moved([10.0, 10.0, 2.0], [30.0, 10.0, 2.0], UP),
            moved([30.0, 10.0, 2.0], [30.0, 20.0, 2.0], UP),
            moved([30.0, 20.0, 2.0], [10.0, 20.0, 2.0], UP),
            moved([10.0, 20.0, 2.0], [10.0, 10.0, 2.0], UP),
        ];
        // the old way round keeps the round's footprint as a ledge inside the hole
        let rounded = finish(&pocketed(), &floor, round(1.0));
        let ledge = push_at(&rounded, [20.0, 15.0, 2.0], UP, -2.5);
        assert!(ledge.mesh.volume() > 40.0 * 30.0 * 6.0 - 20.0 * 10.0 * 6.0 + 1.0);
        // pushed first, the floor is gone and its round with it
        let r = push_at(&pocketed(), [20.0, 15.0, 2.0], UP, -2.5);
        sound(&r.mesh);
        assert!((r.mesh.volume() - (40.0 * 30.0 * 6.0 - 20.0 * 10.0 * 6.0)).abs() < 1e-6);
        for e in &floor {
            let z = vec3::add(e.a, [0.0, 0.0, -2.5]);
            let gone = EdgeRef {
                a: z,
                b: vec3::add(e.b, [0.0, 0.0, -2.5]),
                ..*e
            };
            let err = edge::apply(&r.mesh, &[gone], round(1.0), &BooleanOptions::default())
                .unwrap_err()
                .to_string();
            assert!(err.contains("is not there any more"), "{err}");
        }
    }

    #[test]
    fn pocket_corners_run_through_with_the_floor() {
        // the corner edges end on the floor: their lower ends move along them, and the round
        // covers the whole wall once the floor is through
        let corners = |z: f64| {
            [
                moved([10.0, 10.0, 6.0], [10.0, 10.0, z], [1.0, 0.0, 0.0]),
                moved([30.0, 10.0, 6.0], [30.0, 10.0, z], [-1.0, 0.0, 0.0]),
                moved([30.0, 20.0, 6.0], [30.0, 20.0, z], [-1.0, 0.0, 0.0]),
                moved([10.0, 20.0, 6.0], [10.0, 20.0, z], [1.0, 0.0, 0.0]),
            ]
        };
        let r = push_at(&pocketed(), [20.0, 15.0, 2.0], UP, -2.5);
        let m = finish(&r.mesh, &corners(-0.5), round(1.5));
        sound(&m);
        let plate = build::box_mesh([0.0; 3], [40.0, 30.0, 6.0]);
        let hole = build::box_mesh([10.0, 10.0, -1.0], [30.0, 20.0, 7.0]);
        let through = boolean::boolean(&[plate], &[hole], BoolOp::Difference, &BooleanOptions::default())
            .unwrap()
            .0;
        let reference = finish(&through, &corners(0.0), round(1.5));
        same_volume(&m, &reference);
        // a push that stops short shortens them instead
        let r = push_at(&pocketed(), [20.0, 15.0, 2.0], UP, -1.0);
        let m = finish(&r.mesh, &corners(1.0), round(1.5));
        sound(&m);
    }
}
