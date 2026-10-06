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
            (table.len() - 1) as u32
        });
        ids.push(id);
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
    fn a_cylinder_is_two_caps_and_one_smooth_side() {
        let m = build::cylinder(&crate::vec3::Frame::WORLD, 5.0, 0.0, 10.0, 48);
        let f = recognize(&m);
        let planes = f
            .table
            .iter()
            .filter(|s| matches!(s, Surface::Plane { .. }))
            .count();
        let others = f.table.iter().filter(|s| matches!(s, Surface::Other)).count();
        assert_eq!((planes, others), (2, 1), "{:?}", f.table);
    }

    #[test]
    fn a_rounded_edge_is_one_face_and_the_flat_sides_beside_it_stay_planes() {
        let m = build::box_mesh([0.0; 3], [20.0, 10.0, 5.0]);
        let edge = crate::edge::EdgeRef {
            a: [0.0, 0.0, 5.0],
            b: [20.0, 0.0, 5.0],
            face: [0.0, 0.0, 1.0],
            moved: false,
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
        let others = f.table.iter().filter(|s| matches!(s, Surface::Other)).count();
        assert_eq!((planes, others), (6, 1), "{:?}", f.table);
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
