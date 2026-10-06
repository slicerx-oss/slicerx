// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! fillet and chamfer on the circular edge where a flat face meets a cylinder square to it: a hole's rim, the
//! root of a boss, the rim of a round plate
//!
//! The faces come from the mesh's face ids (`faces.rs`), or from recognition when it has none. The tool is the
//! same cross section as on a straight edge, turned once around the cylinder's axis in as many steps as the rim
//! has sides, starting at one of its corners, so the tool's sides lie along the hole's own.

use super::{End, Geom, MARGIN_MM, Profile, key, section_with, setback};
use crate::error::{Error, Result};
use crate::faces::{self, Faces, Surface};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d::Polygon;
use crate::vec3::{self, Frame, V3};
use std::collections::HashMap;
use std::f64::consts::PI;

/// A closed circular edge between a plane and a cylinder square to it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Rim {
    pub center: V3,
    /// The plane face's outward normal, along the cylinder's axis.
    pub normal: V3,
    pub radius: f64,
    /// A corner of the rim: the tool's turn starts here.
    pub start: V3,
    /// Sides of the rim.
    pub steps: usize,
    /// 1 when the flat face lies outside the circle (a hole, a boss's root), -1 inside (a round plate's rim).
    pub out: f64,
    /// 1 when the cylinder runs from the rim along the plane's normal (a boss), -1 against it (a hole).
    pub along: f64,
    pub convex: bool,
    /// How far the flat face reaches from the rim, and the cylinder runs from it, mm.
    pub room: [f64; 2],
}

type EdgeMap = HashMap<(Key3, Key3), Vec<usize>>;
type Key3 = [u64; 3];

fn edge_key(a: V3, b: V3) -> (Key3, Key3) {
    let (ka, kb) = (key(a), key(b));
    if ka <= kb { (ka, kb) } else { (kb, ka) }
}

fn edge_map(mesh: &TriMesh) -> EdgeMap {
    let mut m: EdgeMap = HashMap::with_capacity(mesh.triangles.len() * 2);
    for (t, &tri) in mesh.triangles.iter().enumerate() {
        let c = mesh.corners(tri);
        for j in 0..3 {
            m.entry(edge_key(c[j], c[(j + 1) % 3])).or_default().push(t);
        }
    }
    m
}

fn surfaces(mesh: &TriMesh) -> Faces {
    mesh.faces
        .clone()
        .filter(|f| f.fit(mesh))
        .unwrap_or_else(|| faces::recognize(mesh))
}

struct Ctx<'a> {
    mesh: &'a TriMesh,
    faces: Faces,
    edges: EdgeMap,
    tol: f64,
}

impl<'a> Ctx<'a> {
    fn new(mesh: &'a TriMesh) -> Self {
        let size = mesh.bounds().map_or(1.0, |b| b.diagonal());
        Self {
            mesh,
            faces: surfaces(mesh),
            edges: edge_map(mesh),
            tol: (size * 1e-6).max(1e-5),
        }
    }

    fn face_of(&self, t: usize) -> u32 {
        self.faces.ids[t]
    }

    fn centroid(&self, t: usize) -> V3 {
        let c = self.mesh.corners(self.mesh.triangles[t]);
        vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0)
    }

    /// The plane and cylinder face on either side of the edge `a b`, when it is one of those.
    fn pair_at(&self, a: V3, b: V3) -> Option<(u32, u32)> {
        let tris = self.edges.get(&edge_key(a, b))?;
        let [t1, t2] = tris[..] else { return None };
        let (f1, f2) = (self.face_of(t1), self.face_of(t2));
        match (self.faces.table[f1 as usize], self.faces.table[f2 as usize]) {
            (Surface::Plane { .. }, Surface::Cylinder { .. }) => Some((f1, f2)),
            (Surface::Cylinder { .. }, Surface::Plane { .. }) => Some((f2, f1)),
            _ => None,
        }
    }

    /// The rim between plane face `pf` and cylinder face `cf`, starting at `prefer` when it is a corner of it.
    fn rim(&self, pf: u32, cf: u32, prefer: Option<V3>) -> Option<Rim> {
        let Surface::Plane { normal, offset } = self.faces.table[pf as usize] else {
            return None;
        };
        let Surface::Cylinder { origin, axis, radius } = self.faces.table[cf as usize] else {
            return None;
        };
        let cos = vec3::dot(normal, axis);
        if cos.abs() < 0.9999 {
            return None;
        }
        let center = vec3::add(
            origin,
            vec3::scale(axis, (offset - vec3::dot(normal, origin)) / cos),
        );
        let radial = |p: V3| {
            let d = vec3::sub(p, center);
            vec3::sub(d, vec3::scale(normal, vec3::dot(d, normal)))
        };
        // The sides of the rim, and one plane and one cylinder triangle beside it.
        let mut sides: Vec<(V3, V3)> = Vec::new();
        let (mut plane_tri, mut cyl_tri) = (None, None);
        let mut rim_keys = std::collections::HashSet::new();
        for (k, tris) in &self.edges {
            let [t1, t2] = tris[..] else { continue };
            let (f1, f2) = (self.face_of(t1), self.face_of(t2));
            let (tp, tc) = if (f1, f2) == (pf, cf) {
                (t1, t2)
            } else if (f2, f1) == (pf, cf) {
                (t2, t1)
            } else {
                continue;
            };
            let c = self.mesh.corners(self.mesh.triangles[tp]);
            let ends: Vec<V3> = c
                .iter()
                .copied()
                .filter(|&p| key(p) == k.0 || key(p) == k.1)
                .collect();
            let [a, b] = ends[..] else { continue };
            sides.push((a, b));
            rim_keys.insert(*k);
            plane_tri.get_or_insert(tp);
            cyl_tri.get_or_insert(tc);
        }
        let (plane_tri, cyl_tri) = (plane_tri?, cyl_tri?);
        // A closed ring, every corner on the circle.
        let mut degree: HashMap<Key3, usize> = HashMap::new();
        for &(a, b) in &sides {
            for p in [a, b] {
                if (vec3::len(radial(p)) - radius).abs() > self.tol * 10.0
                    || (vec3::dot(normal, p) - offset).abs() > self.tol * 10.0
                {
                    return None;
                }
                *degree.entry(key(p)).or_default() += 1;
            }
        }
        if sides.len() < 3 || degree.len() != sides.len() || degree.values().any(|&d| d != 2) {
            return None;
        }
        let start = prefer
            .filter(|p| degree.contains_key(&key(*p)))
            .unwrap_or_else(|| {
                sides
                    .iter()
                    .map(|s| s.0)
                    .min_by_key(|p| key(*p))
                    .unwrap_or(center)
            });
        let out = if vec3::len(radial(self.centroid(plane_tri))) > radius {
            1.0
        } else {
            -1.0
        };
        let along = vec3::dot(vec3::sub(self.centroid(cyl_tri), center), normal).signum();
        let plane_room = self.plane_room(pf, &rim_keys, center, radius, out, &radial);
        let cyl_room = self
            .faces
            .ids
            .iter()
            .enumerate()
            .filter(|&(_, &f)| f == cf)
            .flat_map(|(t, _)| self.mesh.corners(self.mesh.triangles[t]))
            .map(|p| along * vec3::dot(vec3::sub(p, center), normal))
            .fold(0.0, f64::max);
        Some(Rim {
            center,
            normal,
            radius,
            start,
            steps: sides.len(),
            out,
            along,
            convex: along < 0.0,
            room: [plane_room.max(0.0), cyl_room],
        })
    }
}

impl Ctx<'_> {
    /// How far the flat face `pf` reaches from the rim: to its nearest other edge on its side of the circle (`out`
    /// 1 outside, -1 inside), or to the middle when it has none inside.
    fn plane_room(
        &self,
        pf: u32,
        rim: &std::collections::HashSet<(Key3, Key3)>,
        center: V3,
        radius: f64,
        out: f64,
        radial: &dyn Fn(V3) -> V3,
    ) -> f64 {
        let mut room = if out > 0.0 { f64::INFINITY } else { radius };
        for (k, tris) in &self.edges {
            if rim.contains(k) {
                continue;
            }
            let inside: Vec<usize> = tris.iter().copied().filter(|&t| self.face_of(t) == pf).collect();
            if inside.len() != 1 {
                continue;
            }
            let c = self.mesh.corners(self.mesh.triangles[inside[0]]);
            let ends: Vec<V3> = c
                .iter()
                .copied()
                .filter(|&p| key(p) == k.0 || key(p) == k.1)
                .collect();
            let [a, b] = ends[..] else { continue };
            room = room.min(if out > 0.0 {
                super::dist_to_segment(center, a, b) - radius
            } else {
                radius - vec3::len(radial(a)).max(vec3::len(radial(b)))
            });
        }
        room
    }
}

/// The cylinder face of triangle `t` and every rim where it meets a flat face, or none when `t` is not on a
/// cylinder.
pub(crate) fn rims_on(mesh: &TriMesh, t: usize) -> Option<(Surface, Vec<Rim>)> {
    let cx = Ctx::new(mesh);
    let cf = *cx.faces.ids.get(t)?;
    let cyl = cx.faces.table[cf as usize];
    if !matches!(cyl, Surface::Cylinder { .. }) {
        return None;
    }
    let mut planes: Vec<u32> = cx
        .edges
        .values()
        .filter_map(|tris| {
            let [t1, t2] = tris[..] else { return None };
            let (f1, f2) = (cx.face_of(t1), cx.face_of(t2));
            let other = if f1 == cf {
                f2
            } else if f2 == cf {
                f1
            } else {
                return None;
            };
            matches!(cx.faces.table[other as usize], Surface::Plane { .. }).then_some(other)
        })
        .collect();
    planes.sort_unstable();
    planes.dedup();
    Some((
        cyl,
        planes.into_iter().filter_map(|pf| cx.rim(pf, cf, None)).collect(),
    ))
}

/// The rim the mesh edge `a b` lies on, if it is one, starting at its first corner in a fixed order.
pub(super) fn at_edge(mesh: &TriMesh, a: V3, b: V3) -> Option<Rim> {
    let cx = Ctx::new(mesh);
    let (pf, cf) = cx.pair_at(a, b)?;
    cx.rim(pf, cf, None)
}

/// The rim an edge reference names (`center` set), found again on `mesh`.
pub(super) fn of_ref(mesh: &TriMesh, e: &super::EdgeRef, n: usize) -> Result<Rim> {
    let gone = || {
        Error::invalid(
            "edges",
            format!("edge {n} is a round edge that is not there any more; pick it again"),
        )
    };
    let center = e.center.ok_or_else(gone)?;
    let cx = Ctx::new(mesh);
    let mut pairs: Vec<(u32, u32)> = cx
        .edges
        .values()
        .filter_map(|tris| {
            let [t1, t2] = tris[..] else { return None };
            let c = cx.mesh.corners(cx.mesh.triangles[t1]);
            let shared: Vec<V3> = cx
                .mesh
                .corners(cx.mesh.triangles[t2])
                .into_iter()
                .filter(|p| c.iter().any(|q| key(*q) == key(*p)))
                .collect();
            let [a, b] = shared[..] else { return None };
            cx.pair_at(a, b)
        })
        .collect();
    pairs.sort_unstable();
    pairs.dedup();
    let want_r = {
        let d = vec3::sub(e.a, center);
        vec3::len(vec3::sub(d, vec3::scale(e.face, vec3::dot(d, e.face))))
    };
    pairs
        .into_iter()
        .filter_map(|(pf, cf)| cx.rim(pf, cf, Some(e.a)))
        .find(|r| {
            vec3::dot(r.normal, e.face) > 0.9999
                && vec3::len(vec3::sub(r.center, center)) < cx.tol * 100.0
                && (r.radius - want_r).abs() < cx.tol * 100.0
        })
        .ok_or_else(gone)
}

impl Rim {
    pub(super) fn length(&self) -> f64 {
        2.0 * PI * self.radius
    }

    fn radial_at(&self, p: V3) -> V3 {
        let d = vec3::sub(p, self.center);
        vec3::normalize(vec3::sub(d, vec3::scale(self.normal, vec3::dot(d, self.normal))))
            .unwrap_or([1.0, 0.0, 0.0])
    }

    /// The edge's geometry at its start corner, as a straight edge's would be there.
    pub(super) fn geom(&self) -> Geom {
        let e_r = self.radial_at(self.start);
        let ta = vec3::scale(e_r, self.out);
        let tb = vec3::scale(self.normal, self.along);
        let d = vec3::cross(tb, ta);
        let end = End {
            point: self.start,
            normal: d,
            extend: false,
        };
        Geom {
            a: self.start,
            b: self.start,
            d,
            len: 0.0,
            ra: 0,
            rb: 0,
            ta,
            tb,
            phi: vec3::dot(ta, tb).clamp(-1.0, 1.0).m_acos(),
            convex: self.convex,
            ends: [end, end],
        }
    }

    pub(super) fn dihedral_deg(&self) -> f64 {
        self.geom().dihedral_deg()
    }

    /// The widest bevel on the flat face and on the cylinder, and the largest round, that fit.
    pub(super) fn widths(&self, profile: Profile) -> [f64; 2] {
        match profile {
            Profile::Chamfer { d1, d2 } => [d1, d2],
            Profile::Fillet { radius, .. } => [setback(&self.geom(), radius); 2],
        }
    }

    /// The body to take away (a convex rim) or add (a concave one).
    pub(super) fn tool(&self, profile: Profile, n: usize) -> Result<TriMesh> {
        let g = self.geom();
        // Past the hole's sides by more than a side bulges inside the circle, so no sliver of wall is left.
        let sagitta = self.radius * (1.0 - (PI / self.steps as f64).m_cos());
        let ring = section_with(&g, profile, MARGIN_MM.max(2.0 * sagitta));
        let w = vec3::normalize(vec3::sub(g.tb, vec3::scale(g.ta, vec3::dot(g.ta, g.tb)))).unwrap_or(g.tb);
        let e_r = self.radial_at(self.start);
        let mut pts = Vec::with_capacity(ring.len());
        for q in ring {
            let p = vec3::add(
                self.start,
                vec3::add(vec3::scale(g.ta, q[0]), vec3::scale(w, q[1])),
            );
            let d = vec3::sub(p, self.center);
            let x = vec3::dot(d, e_r);
            if x <= 1e-6 {
                return Err(Error::invalid(
                    "edges",
                    format!(
                        "edge {n} is a round edge {:.3} mm across; this size reaches past its middle",
                        2.0 * self.radius
                    ),
                ));
            }
            pts.push([x, vec3::dot(d, self.normal)]);
        }
        let frame = Frame {
            origin: self.center,
            u: e_r,
            v: self.normal,
            w: vec3::cross(e_r, self.normal),
        };
        crate::sketch::revolve_steps(
            &frame,
            &[Polygon::simple(pts)],
            [0.0, 0.0],
            [0.0, 1.0],
            360.0,
            Some(self.steps),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::super::{EdgeRef, apply, pick_edge};
    use super::*;
    use crate::boolean::{self, BoolOp, BooleanOptions};
    use crate::build;

    fn post(r: f64, h0: f64, h1: f64) -> TriMesh {
        let f = Frame {
            origin: [15.0, 10.0, 0.0],
            ..Frame::WORLD
        };
        build::cylinder(&f, r, h0, h1, 48)
    }

    fn plate_with_hole() -> TriMesh {
        let plate = build::box_mesh([0.0; 3], [30.0, 20.0, 5.0]);
        boolean::boolean(
            &[plate],
            &[post(3.0, -1.0, 6.0)],
            BoolOp::Difference,
            &BooleanOptions::default(),
        )
        .unwrap()
        .0
    }

    fn plate_with_boss() -> TriMesh {
        let plate = build::box_mesh([0.0; 3], [30.0, 20.0, 5.0]);
        boolean::boolean(
            &[plate, post(3.0, 5.0, 9.0)],
            &[],
            BoolOp::Union,
            &BooleanOptions::default(),
        )
        .unwrap()
        .0
    }

    /// A triangle of the face at height `z` facing `up`, with a corner on the circle of radius `r`, and that corner.
    fn near_rim(m: &TriMesh, z: f64, up: bool, r: f64) -> (u32, V3) {
        for (t, &tri) in m.triangles.iter().enumerate() {
            let c = m.corners(tri);
            let n = vec3::normalize(m.normal(tri)).unwrap_or([0.0; 3]);
            if (n[2] > 0.99) != up || n[2].abs() < 0.99 || c.iter().any(|p| (p[2] - z).abs() > 1e-6) {
                continue;
            }
            if let Some(&p) = c
                .iter()
                .find(|p| ((p[0] - 15.0).m_hypot(p[1] - 10.0) - r).abs() < 1e-6)
            {
                return (u32::try_from(t).unwrap(), p);
            }
        }
        panic!("no triangle at the rim")
    }

    fn rim_ref(m: &TriMesh, z: f64) -> EdgeRef {
        let (t, at) = near_rim(m, z, true, 3.0);
        let p = pick_edge(m, t, at).unwrap();
        assert!(p.supported, "{:?}", p.reason);
        p.edge
    }

    #[test]
    fn a_holes_rim_is_a_round_edge() {
        let m = plate_with_hole();
        let (t, at) = near_rim(&m, 5.0, true, 3.0);
        let p = pick_edge(&m, t, at).unwrap();
        assert!(p.supported && p.convex, "{:?}", p.reason);
        let c = p.edge.center.unwrap();
        assert!(vec3::len(vec3::sub(c, [15.0, 10.0, 5.0])) < 1e-6, "{c:?}");
        assert!((p.length_mm - 2.0 * PI * 3.0).abs() < 1e-6);
        assert!((p.dihedral_deg - 90.0).abs() < 1e-6);
        // Seven mm of face to the plate's long sides, five down the hole.
        assert!(
            (p.max_distance_mm[0] - 7.0).abs() < 1e-3 && (p.max_distance_mm[1] - 5.0).abs() < 1e-3,
            "{:?}",
            p.max_distance_mm
        );
        assert!((p.max_radius_mm - 5.0).abs() < 1e-3);
    }

    #[test]
    fn chamfer_a_holes_rim() {
        let m = plate_with_hole();
        let e = rim_ref(&m, 5.0);
        let r = apply(
            &m,
            &[e],
            Profile::Chamfer { d1: 1.0, d2: 1.0 },
            &BooleanOptions::default(),
        )
        .unwrap();
        assert!(r.report.watertight && r.report.shells == 1);
        // Pappus: half a square millimeter turned at 3 + 1/3 mm.
        let want = 2.0 * PI * (3.0 + 1.0 / 3.0) * 0.5;
        assert!(
            (-r.report.volume_change_mm3 - want).abs() < 0.03 * want,
            "{} {want}",
            r.report.volume_change_mm3
        );
        let cone =
            r.mesh.faces.as_ref().unwrap().table.iter().any(
                |s| matches!(s, Surface::Cone { half_angle, .. } if (half_angle - PI / 4.0).abs() < 1e-6),
            );
        assert!(cone, "{:?}", r.mesh.faces.as_ref().unwrap().table);
    }

    #[test]
    fn fillet_a_holes_rim_and_a_bosss_root() {
        // The corner left by a quarter round of radius 1, turned at 3 mm plus its centroid's offset.
        let area = 1.0 - PI / 4.0;
        let off = (10.0 - 3.0 * PI) / (12.0 - 3.0 * PI);
        let want = 2.0 * PI * (3.0 + off) * area;
        let fillet = Profile::Fillet {
            radius: 1.0,
            tolerance: 0.01,
        };
        let hole = plate_with_hole();
        let r = apply(&hole, &[rim_ref(&hole, 5.0)], fillet, &BooleanOptions::default()).unwrap();
        assert!(r.report.watertight && r.report.shells == 1);
        assert!(
            (-r.report.volume_change_mm3 - want).abs() < 0.05 * want,
            "{} {want}",
            r.report.volume_change_mm3
        );
        let boss = plate_with_boss();
        let e = rim_ref(&boss, 5.0);
        let r = apply(&boss, &[e], fillet, &BooleanOptions::default()).unwrap();
        assert!(!r.edges[0].convex);
        assert!(r.report.watertight && r.report.shells == 1);
        assert!(
            (r.report.volume_change_mm3 - want).abs() < 0.05 * want,
            "{} {want}",
            r.report.volume_change_mm3
        );
    }

    #[test]
    fn a_rim_without_face_ids_is_found_by_recognition() {
        let mut m = plate_with_hole();
        m.faces = None;
        let e = rim_ref(&m, 5.0);
        let r = apply(
            &m,
            &[e],
            Profile::Chamfer { d1: 0.5, d2: 0.5 },
            &BooleanOptions::default(),
        )
        .unwrap();
        assert!(r.report.watertight && r.report.volume_change_mm3 < 0.0);
    }

    #[test]
    fn a_bevel_too_wide_for_the_face_is_refused() {
        let m = plate_with_hole();
        let e = rim_ref(&m, 5.0);
        let err = apply(
            &m,
            &[e],
            Profile::Chamfer { d1: 8.0, d2: 1.0 },
            &BooleanOptions::default(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("distanceMm") && err.contains('7'), "{err}");
    }
}
