// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! face identity: which triangles of a mesh form one face of the model, and what surface that face is
//!
//! A mesh may carry a face id per triangle and a table of faces. Ops that make geometry tag what they make (a box
//! has six planes), booleans carry the ids through manifold's per-triangle face ids, and a mesh that arrives
//! without them gets them by recognition: coplanar neighbors form a plane, the rest smooth regions.
// triangle and face indices are checked by `Faces::check` when a mesh enters the crate
#![allow(clippy::indexing_slicing)]
#![allow(
    clippy::cast_possible_truncation,
    reason = "triangle and face counts stay below 2^32, checked by `TriMesh::validate`"
)]

use crate::error::{Error, Result};
use crate::mesh::TriMesh;
use crate::vec3::{self, V3};
use crate::xform::{self, Mat4};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The surface a face lies on. Plane normals point out of the solid; the other kinds say nothing about the side.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Surface {
    /// Points `p` with `dot(normal, p) == offset`.
    Plane {
        normal: V3,
        offset: f64,
    },
    /// Points at `radius` from the line through `origin` along the unit `axis`.
    Cylinder {
        origin: V3,
        axis: V3,
        radius: f64,
    },
    /// Points on the cone with its tip at `apex`, opening along the unit `axis` at `half_angle` radians.
    Cone {
        apex: V3,
        axis: V3,
        #[serde(rename = "halfAngle")]
        half_angle: f64,
    },
    Sphere {
        center: V3,
        radius: f64,
    },
    /// A face with no known surface: a smooth region of an imported mesh, a round, text.
    Other,
}

impl Surface {
    /// The same surface seen from the other side (a cutter's face becomes the wall of the hole it cuts).
    #[must_use]
    pub fn flipped(self) -> Self {
        match self {
            Self::Plane { normal, offset } => Self::Plane {
                normal: vec3::scale(normal, -1.0),
                offset: -offset,
            },
            s => s,
        }
    }
}

impl Surface {
    /// The surface after the affine map `m`. Planes follow any map; cylinders, cones and spheres follow a rigid
    /// move or a uniform scale and become `Other` under a stretch, which no longer leaves them round.
    #[must_use]
    pub fn transformed(self, m: &Mat4) -> Self {
        let mirror = xform::det(m) < 0.0;
        match self {
            Self::Plane { normal, offset } => {
                let t1 = vec3::any_perpendicular(normal);
                let t2 = vec3::cross(normal, t1);
                let n = vec3::cross(xform::apply_dir(m, t1), xform::apply_dir(m, t2));
                let Some(n) = vec3::normalize(if mirror { vec3::scale(n, -1.0) } else { n }) else {
                    return Self::Other;
                };
                let p = xform::apply(m, vec3::scale(normal, offset));
                Self::Plane {
                    normal: n,
                    offset: vec3::dot(n, p),
                }
            }
            Self::Other => Self::Other,
            round => {
                let Some(s) = similarity_scale(m) else {
                    return Self::Other;
                };
                let axis_of = |a: V3| vec3::normalize(xform::apply_dir(m, a));
                match round {
                    Self::Cylinder { origin, axis, radius } => {
                        axis_of(axis).map_or(Self::Other, |axis| Self::Cylinder {
                            origin: xform::apply(m, origin),
                            axis,
                            radius: radius * s,
                        })
                    }
                    Self::Cone {
                        apex,
                        axis,
                        half_angle,
                    } => axis_of(axis).map_or(Self::Other, |axis| Self::Cone {
                        apex: xform::apply(m, apex),
                        axis,
                        half_angle,
                    }),
                    Self::Sphere { center, radius } => Self::Sphere {
                        center: xform::apply(m, center),
                        radius: radius * s,
                    },
                    other => other,
                }
            }
        }
    }
}

/// The scale of a map that is a rigid move times a uniform scale (and maybe a mirror), or none.
fn similarity_scale(m: &Mat4) -> Option<f64> {
    let cols = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
    let lens = cols.map(vec3::len);
    let s = lens[0];
    let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * s.max(1.0);
    let square = close(lens[1], s)
        && close(lens[2], s)
        && close(vec3::dot(cols[0], cols[1]), 0.0)
        && close(vec3::dot(cols[1], cols[2]), 0.0)
        && close(vec3::dot(cols[0], cols[2]), 0.0);
    (square && s > 0.0).then_some(s)
}

impl Faces {
    /// The faces after the affine map `m`, each surface moved with it.
    #[must_use]
    pub fn transformed(&self, m: &Mat4) -> Self {
        Self {
            ids: self.ids.clone(),
            table: self.table.iter().map(|s| s.transformed(m)).collect(),
        }
    }
}

/// A face id for each triangle and the surface of each face.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Faces {
    /// One per triangle, an index into `table`.
    pub ids: Vec<u32>,
    pub table: Vec<Surface>,
}

impl Faces {
    pub fn check(&self, what: &str, triangles: usize) -> Result<()> {
        if self.ids.len() != triangles {
            return Err(Error::mesh(what, "faces must have one id per triangle"));
        }
        if self.ids.iter().any(|&i| i as usize >= self.table.len()) {
            return Err(Error::mesh(what, "a face id is not in the face table"));
        }
        Ok(())
    }

    /// Keeps the ids of the triangles `keep` says to keep, in order.
    #[must_use]
    pub fn retained(&self, keep: impl Fn(usize) -> bool) -> Self {
        Self {
            ids: self
                .ids
                .iter()
                .enumerate()
                .filter(|&(i, _)| keep(i))
                .map(|(_, &id)| id)
                .collect(),
            table: self.table.clone(),
        }
        .compacted()
    }

    /// Drops faces no triangle uses and numbers the rest in order of first use.
    #[must_use]
    pub fn compacted(self) -> Self {
        let mut map: HashMap<u32, u32> = HashMap::new();
        let mut table = Vec::new();
        let ids = self
            .ids
            .iter()
            .map(|&id| {
                *map.entry(id).or_insert_with(|| {
                    table.push(self.table[id as usize]);
                    (table.len() - 1) as u32
                })
            })
            .collect();
        Self { ids, table }
    }

    /// True when these faces can belong to `mesh`: one id per triangle, every id in the table, and the first
    /// triangle of each plane face on that plane. A caller that changed the triangles or moved the vertices
    /// without the faces fails this, and its faces are better found again.
    pub fn fit(&self, mesh: &TriMesh) -> bool {
        if self.check("mesh", mesh.triangles.len()).is_err() {
            return false;
        }
        let size = mesh.bounds().map_or(1.0, |b| b.diagonal());
        let tol = (size * 1e-6).max(1e-4);
        let mut seen = vec![false; self.table.len()];
        self.ids.iter().zip(&mesh.triangles).all(|(&id, &t)| {
            if std::mem::replace(&mut seen[id as usize], true) {
                return true;
            }
            match self.table[id as usize] {
                Surface::Plane { normal, offset } => mesh
                    .corners(t)
                    .iter()
                    .all(|&p| (vec3::dot(normal, p) - offset).abs() < tol),
                _ => true,
            }
        })
    }

    /// Adds a face to the table and returns its id.
    pub fn push(&mut self, s: Surface) -> u32 {
        self.table.push(s);
        (self.table.len() - 1) as u32
    }

    /// The triangles of face `id`.
    pub fn triangles_of(&self, id: u32) -> Vec<u32> {
        self.ids
            .iter()
            .enumerate()
            .filter(|&(_, &f)| f == id)
            .map(|(t, _)| t as u32)
            .collect()
    }
}

/// Neighbors closer to parallel than this belong to one flat face.
const FLAT_COS: f64 = 0.999_999;
/// Neighbors closer to parallel than this belong to one smooth face (about 25 degrees, finer than any corner a
/// part is drawn with and coarser than the facets of a tessellated round).
const SMOOTH_COS: f64 = 0.906;
/// A flat group in a smooth region is a plane of its own when its area is this many times the region's median
/// group (a facet strip of a round is about the median; the flat top beside the round is far larger).
const PLANE_OVER_FACET: f64 = 4.0;
/// A smooth face is a cylinder when its corners fit one to within this share of the radius: a tessellated
/// cylinder's corners lie on it exactly; a round that turns a corner into a sphere does not fit.
const CYLINDER_FIT: f64 = 1e-4;

/// Faces found from the mesh alone: coplanar neighbors across an edge form a plane, and the facets of a round
/// (neighbors that meet at a shallow angle, none much larger than the others) form one smooth face.
pub fn recognize(mesh: &TriMesh) -> Faces {
    let n = mesh.triangles.len();
    let normals: Vec<Option<V3>> = mesh
        .triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|i| mesh.positions[i as usize]);
            vec3::normalize(vec3::tri_normal(a, b, c))
        })
        .collect();
    let size = mesh.bounds().map_or(1.0, |b| b.diagonal());
    let tol = (size * 1e-6).max(1e-6);
    let mut edges: HashMap<(u32, u32), Vec<u32>> = HashMap::with_capacity(n * 2);
    for (t, tri) in mesh.triangles.iter().enumerate() {
        for j in 0..3 {
            let (a, b) = (tri[j], tri[(j + 1) % 3]);
            edges.entry((a.min(b), a.max(b))).or_default().push(t as u32);
        }
    }
    let mut parent: Vec<u32> = (0..n as u32).collect();
    let flat = |s: usize, t: usize| -> bool {
        let (Some(ns), Some(nt)) = (normals[s], normals[t]) else {
            return false;
        };
        if vec3::dot(ns, nt) < FLAT_COS {
            return false;
        }
        let p0 = mesh.positions[mesh.triangles[s][0] as usize];
        mesh.triangles[t]
            .iter()
            .all(|&i| vec3::dot(vec3::sub(mesh.positions[i as usize], p0), ns).abs() < tol)
    };
    let mut pairs: Vec<(u32, u32)> = edges
        .values()
        .filter(|f| f.len() == 2)
        .map(|f| (f[0].min(f[1]), f[0].max(f[1])))
        .collect();
    pairs.sort_unstable();
    // 1. Coplanar neighbors form flat groups: a box side, or one facet strip of a tessellated round.
    for &(s, t) in &pairs {
        if flat(s as usize, t as usize) {
            union(&mut parent, s, t);
        }
    }
    let group: Vec<u32> = (0..n as u32).map(|t| root(&mut parent, t)).collect();
    let mut area: HashMap<u32, f64> = HashMap::new();
    for (t, tri) in mesh.triangles.iter().enumerate() {
        let [a, b, c] = tri.map(|i| mesh.positions[i as usize]);
        *area.entry(group[t]).or_default() += vec3::len(vec3::tri_normal(a, b, c)) * 0.5;
    }
    // 2. Groups that meet at a shallow angle form smooth regions.
    let smooth = |s: u32, t: u32| match (normals[s as usize], normals[t as usize]) {
        (Some(a), Some(b)) => vec3::dot(a, b) > SMOOTH_COS,
        _ => false,
    };
    let mut region: Vec<u32> = (0..n as u32).collect();
    for &(s, t) in &pairs {
        if group[s as usize] != group[t as usize] && smooth(s, t) {
            union(&mut region, group[s as usize], group[t as usize]);
        }
    }
    // 3. In a region, a group much larger than its typical facet is a real plane (the top beside a round);
    // the other groups are facets of the round and join each other into one face.
    let mut by_region: HashMap<u32, Vec<f64>> = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    for &g in &group {
        if seen.insert(g) {
            let r = root(&mut region, g);
            by_region
                .entry(r)
                .or_default()
                .push(area.get(&g).copied().unwrap_or(0.0));
        }
    }
    let mut typical: HashMap<u32, (usize, f64)> = HashMap::new();
    for (r, mut areas) in by_region {
        areas.sort_by(f64::total_cmp);
        typical.insert(r, (areas.len(), areas[areas.len() / 2]));
    }
    let mut plane = |g: u32| -> bool {
        let r = root(&mut region, g);
        let (count, median) = typical.get(&r).copied().unwrap_or((1, 0.0));
        count == 1 || area.get(&g).copied().unwrap_or(0.0) > PLANE_OVER_FACET * median
    };
    let is_plane: HashMap<u32, bool> = group.iter().map(|&g| (g, plane(g))).collect();
    let mut face = group.clone();
    for &(s, t) in &pairs {
        let (gs, gt) = (group[s as usize], group[t as usize]);
        if gs != gt && smooth(s, t) && !is_plane[&gs] && !is_plane[&gt] {
            union(&mut face, gs, gt);
        }
    }
    number(mesh, &normals, &group, &mut face, &is_plane)
}

/// Numbers the faces in order of first use, each with its surface: the plane of a flat group, or none known.
fn number(
    mesh: &TriMesh,
    normals: &[Option<V3>],
    group: &[u32],
    face: &mut [u32],
    is_plane: &HashMap<u32, bool>,
) -> Faces {
    let n = group.len();
    let mut ids = Vec::with_capacity(n);
    let mut table = Vec::new();
    let mut map: HashMap<u32, u32> = HashMap::new();
    let mut round: Vec<Vec<u32>> = Vec::new();
    for t in 0..n {
        let f = root(face, group[t]);
        let id = *map.entry(f).or_insert_with(|| {
            let surface = match normals[t] {
                Some(normal) if is_plane[&group[t]] => {
                    let p = mesh.positions[mesh.triangles[t][0] as usize];
                    Surface::Plane {
                        normal,
                        offset: vec3::dot(normal, p),
                    }
                }
                _ => Surface::Other,
            };
            table.push(surface);
            round.push(Vec::new());
            (table.len() - 1) as u32
        });
        round[id as usize].push(t as u32);
        ids.push(id);
    }
    // A smooth face whose facets all lie on one cylinder is that cylinder (a hole, a boss, a rounded edge).
    for (id, tris) in round.iter().enumerate() {
        if matches!(table[id], Surface::Other)
            && let Some((origin, axis, radius)) = crate::measure::fit_cylinder(mesh, tris, CYLINDER_FIT)
        {
            table[id] = Surface::Cylinder { origin, axis, radius };
        }
    }
    Faces { ids, table }
}

fn root(p: &mut [u32], mut i: u32) -> u32 {
    while p[i as usize] != i {
        p[i as usize] = p[p[i as usize] as usize];
        i = p[i as usize];
    }
    i
}

fn union(p: &mut [u32], a: u32, b: u32) {
    let (a, b) = (root(p, a), root(p, b));
    if a != b {
        p[a.max(b) as usize] = a.min(b);
    }
}

/// Joins faces that lie on the same plane and meet across an edge (two blocks united side by side have one top).
#[must_use]
pub fn merge_meeting_planes(mesh: &TriMesh, f: Faces) -> Faces {
    let size = mesh.bounds().map_or(1.0, |b| b.diagonal());
    let tol = (size * 1e-6).max(1e-6);
    let mut parent: Vec<u32> = (0..f.table.len() as u32).collect();
    let mut edges: HashMap<(u32, u32), u32> = HashMap::with_capacity(mesh.triangles.len() * 2);
    for (t, tri) in mesh.triangles.iter().enumerate() {
        for j in 0..3 {
            let (a, b) = (tri[j], tri[(j + 1) % 3]);
            let key = (a.min(b), a.max(b));
            match edges.get(&key) {
                Some(&other) => {
                    let (fa, fb) = (f.ids[t], f.ids[other as usize]);
                    if fa != fb && same_plane(f.table[fa as usize], f.table[fb as usize], tol) {
                        union(&mut parent, fa, fb);
                    }
                }
                None => {
                    edges.insert(key, t as u32);
                }
            }
        }
    }
    Faces {
        ids: f.ids.iter().map(|&id| root(&mut parent, id)).collect(),
        table: f.table,
    }
    .compacted()
}

/// The plane of a box face along `axis` (0, 1 or 2), on its `max` side or not.
pub(crate) fn box_plane(axis: usize, max: bool, at: f64) -> Surface {
    let mut normal = [0.0; 3];
    let sign = if max { 1.0 } else { -1.0 };
    normal[axis] = sign;
    Surface::Plane {
        normal,
        offset: sign * at,
    }
}

/// True when two planes are the same plane facing the same way, within `tol` mm and about 0.1 degree.
pub fn same_plane(a: Surface, b: Surface, tol: f64) -> bool {
    match (a, b) {
        (
            Surface::Plane {
                normal: na,
                offset: oa,
            },
            Surface::Plane {
                normal: nb,
                offset: ob,
            },
        ) => vec3::dot(na, nb) > 0.999_998 && (oa - ob).abs() < tol,
        _ => false,
    }
}

/// Checks for tests: the faces a mesh carries agree with its geometry.
#[cfg(test)]
pub(crate) mod check {
    use super::*;

    /// Every triangle of a plane face lies on that plane and faces the way it does; every triangle of a cylinder
    /// face has its corners at the radius. Returns the number of faces.
    pub(crate) fn faces_agree(m: &TriMesh) -> usize {
        let f = m.faces.as_ref().expect("the mesh has faces");
        f.check("mesh", m.triangles.len()).unwrap();
        for (t, &id) in f.ids.iter().enumerate() {
            let [a, b, c] = m.corners(m.triangles[t]);
            match f.table[id as usize] {
                Surface::Plane { normal, offset } => {
                    for p in [a, b, c] {
                        assert!(
                            (vec3::dot(normal, p) - offset).abs() < 1e-6,
                            "triangle {t} is off its plane"
                        );
                    }
                    let n = vec3::normalize(vec3::tri_normal(a, b, c)).unwrap();
                    assert!(
                        vec3::dot(n, normal) > 0.9999,
                        "triangle {t} faces away from its plane"
                    );
                }
                Surface::Cylinder { origin, axis, radius } => {
                    for p in [a, b, c] {
                        let d = vec3::sub(p, origin);
                        let r = vec3::len(vec3::sub(d, vec3::scale(axis, vec3::dot(d, axis))));
                        assert!(
                            (r - radius).abs() < 1e-6,
                            "triangle {t} is off its cylinder: {r} against {radius}"
                        );
                    }
                }
                _ => {}
            }
        }
        f.table.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    #[test]
    fn a_box_is_recognized_as_six_planes() {
        let m = build::box_mesh([0.0; 3], [10.0, 20.0, 30.0]);
        let f = recognize(&m);
        assert_eq!(f.ids.len(), 12);
        assert_eq!(f.table.len(), 6);
        assert!(f.table.iter().all(|s| matches!(s, Surface::Plane { .. })));
        // The two triangles of each side share a face.
        for pair in f.ids.chunks(2) {
            assert_eq!(pair[0], pair[1]);
        }
        let top = f
            .table
            .iter()
            .find(|s| matches!(s, Surface::Plane { normal, .. } if normal[2] > 0.5))
            .copied()
            .unwrap();
        assert!(same_plane(top, box_plane(2, true, 30.0), 1e-9), "{top:?}");
    }

    #[test]
    fn a_cylinder_is_two_caps_and_one_round_side() {
        let m = build::cylinder(&crate::vec3::Frame::WORLD, 5.0, 0.0, 10.0, 48);
        let f = recognize(&m);
        let planes = f
            .table
            .iter()
            .filter(|s| matches!(s, Surface::Plane { .. }))
            .count();
        let round: Vec<Surface> = f
            .table
            .iter()
            .filter(|s| !matches!(s, Surface::Plane { .. }))
            .copied()
            .collect();
        assert_eq!(planes, 2, "{:?}", f.table);
        let [Surface::Cylinder { origin, axis, radius }] = round[..] else {
            panic!("not one cylinder: {round:?}")
        };
        assert!(
            (radius - 5.0).abs() < 1e-6 && axis[2].abs() > 0.999_999,
            "{round:?}"
        );
        assert!(origin[0].abs() < 1e-6 && origin[1].abs() < 1e-6, "{origin:?}");
        let mut m = m;
        m.faces = Some(f);
        check::faces_agree(&m);
    }

    #[test]
    fn a_rounded_edge_is_one_cylinder_and_the_flat_sides_beside_it_stay_planes() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let edge = crate::edge::EdgeRef {
            a: [0.0, 0.0, 5.0],
            b: [20.0, 0.0, 5.0],
            face: [0.0, 0.0, 1.0],
            moved: false,
            center: None,
        };
        let profile = crate::edge::Profile::Fillet {
            radius: 2.0,
            tolerance: 0.01,
        };
        let r = crate::edge::apply(&m, &[edge], profile, &crate::boolean::BooleanOptions::default()).unwrap();
        let f = recognize(&r.mesh);
        let planes = f
            .table
            .iter()
            .filter(|s| matches!(s, Surface::Plane { .. }))
            .count();
        let round: Vec<Surface> = f
            .table
            .iter()
            .filter(|s| !matches!(s, Surface::Plane { .. }))
            .copied()
            .collect();
        assert_eq!(planes, 6, "{:?}", f.table);
        let [Surface::Cylinder { radius, axis, .. }] = round[..] else {
            panic!("not one cylinder: {round:?}")
        };
        assert!(
            (radius - 2.0).abs() < 1e-6 && axis[0].abs() > 0.999_999,
            "{round:?}"
        );
    }

    #[test]
    fn a_box_is_made_with_its_six_planes() {
        let m = build::box_mesh([1.0, 2.0, 3.0], [11.0, 22.0, 33.0]);
        let made = m.faces.clone().unwrap();
        made.check("box", m.triangles.len()).unwrap();
        // The planes it was made with are the planes its triangles lie on.
        for (t, &id) in made.ids.iter().enumerate() {
            let Surface::Plane { normal, offset } = made.table[id as usize] else {
                panic!("not a plane")
            };
            for &v in &m.triangles[t] {
                assert!((vec3::dot(normal, m.positions[v as usize]) - offset).abs() < 1e-9);
            }
            let [a, b, c] = m.triangles[t].map(|i| m.positions[i as usize]);
            assert!(vec3::dot(vec3::normalize(vec3::tri_normal(a, b, c)).unwrap(), normal) > 0.999_999);
        }
        assert_eq!(recognize(&m).table.len(), 6);
    }

    use crate::fm::Fm as _;

    fn kinds(m: &TriMesh) -> (usize, usize) {
        let f = m.faces.as_ref().unwrap();
        let planes = f
            .table
            .iter()
            .filter(|s| matches!(s, Surface::Plane { .. }))
            .count();
        let cylinders = f
            .table
            .iter()
            .filter(|s| matches!(s, Surface::Cylinder { .. }))
            .count();
        (planes, cylinders)
    }

    #[test]
    fn an_extruded_circle_is_two_caps_and_a_cylinder() {
        let frame = crate::vec3::Frame::from_normal([1.0, 2.0, 3.0], [0.2, -0.3, 1.0], None).unwrap();
        let m = build::cylinder(&frame, 4.0, 0.0, 6.0, 64);
        assert_eq!(check::faces_agree(&m), 3);
        assert_eq!(kinds(&m), (2, 1));
    }

    #[test]
    fn an_extruded_rounded_rectangle_has_four_flat_sides_and_four_round_corners() {
        use crate::poly2d::{self, Polygon};
        let mut ring = Vec::new();
        for (cx, cy, a0) in [
            (8.0, 3.0, 0.0),
            (2.0, 3.0, 90.0),
            (2.0, -3.0, 180.0),
            (8.0, -3.0, 270.0),
        ] {
            for k in 0..=8 {
                let a = (a0 + f64::from(k) * 90.0 / 8.0_f64).to_radians();
                ring.push([cx + 2.0 * a.m_cos(), cy + 2.0 * a.m_sin()]);
            }
        }
        ring.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9);
        let m = build::extrude(&[Polygon::simple(ring)], &crate::vec3::Frame::WORLD, 0.0, 5.0).unwrap();
        assert_eq!(check::faces_agree(&m), 10);
        assert_eq!(kinds(&m), (6, 4));
        let hexagon = Polygon::simple(poly2d::circle([0.0, 0.0], 5.0, 6));
        let h = build::extrude(&[hexagon], &crate::vec3::Frame::WORLD, 0.0, 5.0).unwrap();
        assert_eq!(kinds(&h), (8, 0));
    }

    #[test]
    fn a_round_hole_in_an_extrusion_is_a_cylinder_facing_in() {
        use crate::poly2d::{self, Polygon};
        let mut hole = poly2d::circle([0.0, 0.0], 2.0, 48);
        hole.reverse();
        let ring = Polygon {
            outer: vec![[-6.0, -6.0], [6.0, -6.0], [6.0, 6.0], [-6.0, 6.0]],
            holes: vec![hole],
        };
        let m = build::extrude(&[ring], &crate::vec3::Frame::WORLD, 0.0, 3.0).unwrap();
        assert_eq!(check::faces_agree(&m), 7);
        assert_eq!(kinds(&m), (6, 1));
    }

    #[test]
    fn retained_ids_follow_the_kept_triangles_and_drop_unused_faces() {
        let m = build::box_mesh([0.0; 3], [1.0; 3]);
        let f = recognize(&m);
        let kept = f.retained(|i| i < 4);
        assert_eq!(kept.ids.len(), 4);
        assert_eq!(kept.table.len(), 2);
        assert!(kept.check("faces", 4).is_ok());
    }
}
