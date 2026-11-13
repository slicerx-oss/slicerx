// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a body as triangles, with everything the kernel knows about them kept
//!
//! The positions are the kernel's own mesh vertices: triangles that share a kernel vertex share an index, and no
//! two points are joined because they round alike. Each triangle has its face, each corner the surface normal the
//! kernel stored there, and each edge of the body its run of points.

use crate::body::{Body, Curve, Surface};
use crate::error::{Error, Result};
use crate::kernel::{EdgeRef, FaceRef};
use crate::values::{Params, Polygons, Vec3};
use std::collections::HashMap;

/// How finely to tessellate. A limit of 0 is off.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tessellation {
    /// The farthest a triangle may sit from its surface, in mm.
    pub chord_mm: f64,
    /// The most an edge's direction may turn between two of its points, in degrees.
    pub curve_angle_deg: f64,
    /// The most a surface's normal may turn across one triangle, in degrees.
    pub surface_angle_deg: f64,
    /// The length triangle sides are split toward, in mm. The kernel aims for it and may leave a side a little
    /// longer.
    pub max_edge_mm: f64,
    /// The kernel's limit on how long and thin a triangle may be, as its aspect ratio.
    pub max_aspect: f64,
}

impl Default for Tessellation {
    /// A 0.01 mm chord and 15 degree angles, as the `tessellate` operation of [`crate::call`] uses.
    fn default() -> Self {
        Self {
            chord_mm: 0.01,
            curve_angle_deg: 15.0,
            surface_angle_deg: 15.0,
            max_edge_mm: 0.0,
            max_aspect: 0.0,
        }
    }
}

impl Tessellation {
    fn checked(&self) -> Result<Params> {
        let limit = |what: &'static str, v: f64, why: &str| {
            if v.is_finite() && v >= 0.0 {
                Ok(v)
            } else {
                Err(Error::input(what, why))
            }
        };
        let angle = |what: &'static str, v: f64| {
            if v.is_finite() && (0.0..=90.0).contains(&v) {
                Ok(v)
            } else {
                Err(Error::input(what, "must be from 0 to 90 degrees"))
            }
        };
        let params = Params {
            chord: limit("chord", self.chord_mm, "must be 0 mm or more")?,
            curve_angle_deg: angle("curve angle", self.curve_angle_deg)?,
            surface_angle_deg: angle("surface angle", self.surface_angle_deg)?,
            max_edge: limit("largest edge", self.max_edge_mm, "must be 0 mm or more")?,
            max_aspect: limit("aspect ratio", self.max_aspect, "must be 0 or more")?,
        };
        // with neither, nothing says how closely round faces are followed
        if params.chord == 0.0 && params.surface_angle_deg == 0.0 {
            return Err(Error::input("chord", "give a chord or a surface angle above 0"));
        }
        Ok(params)
    }
}

/// An edge of the body in a [`Mesh`].
#[derive(Debug, Clone, PartialEq)]
pub struct MeshEdge {
    /// The two faces it joins, as indices into [`Mesh::surfaces`]. A seam, where a face meets itself, has the same
    /// face twice.
    pub faces: [u32; 2],
    pub curve: Curve,
    /// Whether the two faces meet smoothly along it. False is a sharp edge.
    pub tangent: bool,
    /// Its points in order along it, as indices into [`Mesh::positions`], from its end with the lower index. An
    /// edge that closes on itself starts at its lowest index, runs toward the lower neighbor and repeats the start
    /// at the end. Empty for an edge of no length.
    pub points: Vec<u32>,
}

/// The triangles of a body.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mesh {
    /// The kernel's mesh vertices. Two faces that share an edge share its points here.
    pub positions: Vec<[f64; 3]>,
    /// Counterclockwise seen from outside the solid.
    pub triangles: Vec<[u32; 3]>,
    /// For each triangle, its face: an index into `surfaces`, and its place in [`Body::faces`].
    pub faces: Vec<u32>,
    /// For each triangle, the surface normal at each of its corners, from the kernel's tessellation. None when
    /// the kernel stored no normal at one of the three, or one that is not finite or points against the
    /// triangle's winding: then the triangle has only its own flat normal. None also for a triangle of a cone
    /// with a corner at the cone's tip, where the surface has no one normal and the kernel stores a single
    /// direction for every triangle around it.
    pub normals: Vec<Option<[[f64; 3]; 3]>>,
    /// For each triangle, where each of its corners is on its face's surface, in the surface's own two parameters
    /// ([`crate::Face::point_at`]). None when the kernel stored no place at one of the three.
    pub uvs: Vec<Option<[[f64; 2]; 3]>>,
    /// The surface of every face of the body, in face order.
    pub surfaces: Vec<Surface>,
    /// Every edge of the body, in edge order.
    pub edges: Vec<MeshEdge>,
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The three corner normals of a triangle, when the kernel stored a usable one at every corner: present, finite
/// and on the side the triangle's winding faces. One bad corner leaves the whole triangle without.
fn corner_normals(corners: [[f64; 3]; 3], stored: [Option<Vec3>; 3]) -> Option<[[f64; 3]; 3]> {
    let winding = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
    let [a, b, c] = stored;
    let normals: [[f64; 3]; 3] = [a?.into(), b?.into(), c?.into()];
    normals
        .iter()
        .all(|n| n.iter().all(|c| c.is_finite()) && dot(*n, winding) > 0.0)
        .then_some(normals)
}

/// Whether a triangle of this surface has a corner at a cone's tip. The tip is matched to within 1e-9 mm, scaled
/// up with the size of its coordinates.
fn at_tip(surface: Option<&Surface>, corners: [[f64; 3]; 3]) -> bool {
    let Some(&Surface::Cone { apex: Some(tip), .. }) = surface else {
        return false;
    };
    let reach = 1e-9 * tip.iter().fold(1.0_f64, |m, c| m.max(c.abs()));
    corners
        .iter()
        .any(|p| (0..3).all(|i| (p[i] - tip[i]).abs() <= reach))
}

/// The points of one edge in order, from the triangle sides that lie on it. None when the sides do not form one
/// line or one ring.
fn chain(sides: &[[u32; 2]]) -> Option<Vec<u32>> {
    // both faces of an edge walk it, in opposite directions: each side once
    let mut next: HashMap<u32, Vec<u32>> = HashMap::new();
    for &[a, b] in sides {
        if a == b {
            return None;
        }
        for (from, to) in [(a, b), (b, a)] {
            let to_list = next.entry(from).or_default();
            if !to_list.contains(&to) {
                to_list.push(to);
            }
        }
    }
    if next.values().any(|n| n.len() > 2) {
        return None;
    }
    let ends: Vec<u32> = next
        .iter()
        .filter(|(_, n)| n.len() == 1)
        .map(|(&p, _)| p)
        .collect();
    let ring = ends.is_empty();
    if !ring && ends.len() != 2 {
        return None;
    }
    let start = if ring {
        next.keys().copied().min()?
    } else {
        ends.iter().copied().min()?
    };
    let mut points = vec![start];
    let (mut before, mut at) = (start, next.get(&start)?.iter().copied().min()?);
    while at != start {
        points.push(at);
        let Some(&on) = next.get(&at)?.iter().find(|&&p| p != before) else {
            break;
        };
        (before, at) = (at, on);
    }
    if ring {
        points.push(start);
    }
    // every point reached: two rings, or a ring and a line, are not one edge
    (points.len() == next.len() + usize::from(ring)).then_some(points)
}

/// The points of every edge, from the triangles. The kernel's mesh does not say which edge a triangle side lies
/// on, but its shape does: a side lies on an edge where triangles of two faces meet, or where one face meets
/// itself along a seam, which shows as the kernel keeping two normal records for each end of the side. `joined`
/// has the two faces of each edge. Where several edges join the same faces, `distance` (from an edge to a side's
/// middle) picks the nearest.
fn edge_runs(
    triangles: &[[u32; 3]],
    faces: &[u32],
    records: &[[Option<u32>; 3]],
    joined: &[[u32; 2]],
    distance: impl Fn(usize, [u32; 2]) -> Result<f64>,
) -> Result<Vec<Vec<u32>>> {
    let pair = |a: u32, b: u32| (a.min(b), a.max(b));
    let mut between: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (edge, &[a, b]) in joined.iter().enumerate() {
        between.entry(pair(a, b)).or_default().push(edge);
    }
    // each side with the triangles on it
    let mut users: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (t, corners) in triangles.iter().enumerate() {
        for k in 0..3 {
            users
                .entry(pair(corners[k], corners[(k + 1) % 3]))
                .or_default()
                .push(t);
        }
    }
    let record = |t: usize, point: u32| {
        let k = triangles[t].iter().position(|&p| p == point)?;
        records[t][k]
    };
    let mut on_edge: Vec<Vec<[u32; 2]>> = vec![Vec::new(); joined.len()];
    let mut sides: Vec<_> = users.into_iter().collect();
    sides.sort_unstable();
    for ((a, b), on) in sides {
        let [t, u] = on[..] else { continue };
        let seam = faces[t] == faces[u];
        if seam && (record(t, a) == record(u, a) || record(t, b) == record(u, b)) {
            // inside a face
            continue;
        }
        let edge = match between.get(&pair(faces[t], faces[u])).map(Vec::as_slice) {
            Some(&[only]) => only,
            Some(several) if !several.is_empty() => {
                let mut nearest = (f64::INFINITY, several[0]);
                for &edge in several {
                    let d = distance(edge, [a, b])?;
                    if d < nearest.0 {
                        nearest = (d, edge);
                    }
                }
                nearest.1
            }
            _ if seam => continue,
            _ => {
                return Err(mesh_error(&format!(
                    "triangles of faces {} and {} meet where the body has no edge",
                    faces[t], faces[u]
                )));
            }
        };
        on_edge[edge].push([a, b]);
    }
    on_edge
        .iter()
        .enumerate()
        .map(|(i, sides)| {
            if sides.is_empty() {
                return Ok(Vec::new());
            }
            chain(sides)
                .ok_or_else(|| mesh_error(&format!("the mesh points along edge {i} do not form one line")))
        })
        .collect()
}

impl Body {
    /// The body as triangles. The kernel tessellates every face or none: a face it cannot do is an error that
    /// names it.
    pub fn tessellate(&self, how: &Tessellation) -> Result<Mesh> {
        self.triangles(how, true)
    }

    /// The body as triangles just as the kernel made them, which may miss the chord asked. For measuring only: the
    /// points the kernel puts on the body's edges, which are on the edges' curves whatever the faces' triangles
    /// are, and a test's own measure of a body. No operation hands these out.
    #[doc(hidden)]
    pub fn tessellate_as_made(&self, how: &Tessellation) -> Result<Mesh> {
        self.triangles(how, false)
    }

    fn triangles(&self, how: &Tessellation, held_to_chord: bool) -> Result<Mesh> {
        let params = how.checked()?;
        let solid = self.solid();
        let mut polygons = solid.tessellate(params)?;
        let face_list = solid.faces()?;
        let edge_list = solid.edges()?;
        let joined = faces_of_edges(&face_list, &edge_list)?;
        // the kernel does not always hold the chord it is asked for: read it back, and split what is past it
        if held_to_chord && params.chord > 0.0 {
            crate::readback::held_to_chord(&face_list, &edge_list, &joined, &mut polygons, params.chord)?;
        }
        let Polygons {
            positions,
            triangles,
            faces,
            normals,
            records,
            uvs,
        } = polygons;
        let uvs = uvs
            .into_iter()
            .map(|[first, second, third]| Some([first?, second?, third?]))
            .collect();
        let positions: Vec<[f64; 3]> = positions.into_iter().map(Into::into).collect();
        if positions.iter().flatten().any(|c| !c.is_finite()) {
            return Err(mesh_error("the kernel returned a point that is not finite"));
        }
        let at = |i: u32| positions[i as usize];
        let surfaces: Vec<Surface> = face_list.iter().map(|f| f.shape().into()).collect();
        let normals = triangles
            .iter()
            .zip(normals)
            .zip(&faces)
            .map(|((t, stored), &face)| {
                let corners = t.map(at);
                if at_tip(surfaces.get(face as usize), corners) {
                    return None;
                }
                corner_normals(corners, stored)
            })
            .collect();
        let middle = |[a, b]: [u32; 2]| {
            let (a, b) = (at(a), at(b));
            [0, 1, 2].map(|i| f64::midpoint(a[i], b[i]))
        };
        let runs = edge_runs(&triangles, &faces, &records, &joined, |edge, side| {
            edge_list[edge].distance_to(middle(side).into())
        })?;
        let edges = edge_list
            .iter()
            .zip(joined)
            .zip(runs)
            .map(|((edge, faces), points)| MeshEdge {
                faces,
                curve: Curve::of(edge.curve_type()),
                tangent: edge.is_tangent(),
                points,
            })
            .collect();
        Ok(Mesh {
            positions,
            triangles,
            faces,
            normals,
            uvs,
            surfaces,
            edges,
        })
    }
}

/// The two faces each edge joins, as places in `faces`. A seam, where a face meets itself, has the same face twice.
fn faces_of_edges(faces: &[FaceRef<'_>], edges: &[EdgeRef<'_>]) -> Result<Vec<[u32; 2]>> {
    let mut joined = Vec::with_capacity(edges.len());
    for (i, edge) in edges.iter().enumerate() {
        let on: Vec<u32> = edge
            .faces()
            .iter()
            .filter_map(|f| faces.iter().position(|g| g == f))
            .filter_map(|f| u32::try_from(f).ok())
            .collect();
        joined.push(match on[..] {
            [a, b] => [a, b],
            [a] => [a, a],
            _ => {
                return Err(mesh_error(&format!(
                    "edge {i} lies on {} faces of the body, not two",
                    on.len()
                )));
            }
        });
    }
    Ok(joined)
}

fn mesh_error(why: &str) -> Error {
    Error::Mesh { why: why.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRIANGLE: [[f64; 3]; 3] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

    #[allow(
        clippy::unnecessary_wraps,
        reason = "a normal the kernel stored, as tessellation hands it over"
    )]
    fn v(x: f64, y: f64, z: f64) -> Option<Vec3> {
        Some(Vec3 { x, y, z })
    }

    /// The kernel's own triangles of a body, and the same held to the chord.
    fn made_and_held(body: &Body) -> (Polygons, Polygons) {
        let params = Tessellation::default().checked().unwrap();
        let solid = body.solid();
        let made = solid.tessellate(params).unwrap();
        let (faces, edges) = (solid.faces().unwrap(), solid.edges().unwrap());
        let joined = faces_of_edges(&faces, &edges).unwrap();
        let mut held = made.clone();
        crate::readback::held_to_chord(&faces, &edges, &joined, &mut held, params.chord).unwrap();
        (made, held)
    }

    /// The farthest a mesh's triangles are from their faces, at their middles and the middles of their sides.
    fn farthest(body: &Body, mesh: &Polygons) -> f64 {
        let faces = body.solid().faces().unwrap();
        let mut worst = 0.0_f64;
        for (corners, &face) in mesh.triangles.iter().zip(&mesh.faces) {
            let [pa, pb, pc]: [[f64; 3]; 3] = corners.map(|vertex| mesh.positions[vertex as usize].into());
            let mid = |points: &[[f64; 3]]| -> [f64; 3] {
                #[allow(clippy::cast_precision_loss, reason = "two or three")]
                let n = points.len() as f64;
                [0, 1, 2].map(|k| points.iter().map(|p| p[k]).sum::<f64>() / n)
            };
            for sample in [mid(&[pa, pb, pc]), mid(&[pa, pb]), mid(&[pb, pc]), mid(&[pc, pa])] {
                worst = worst.max(faces[face as usize].distance_to(sample.into()).unwrap());
            }
        }
        worst
    }

    // triangles the kernel made within the chord come back from the read-back exactly as it made them
    #[test]
    fn a_mesh_within_its_chord_is_left_as_the_kernel_made_it() {
        if !crate::KERNEL {
            return;
        }
        for (name, body) in [
            ("box", Body::cuboid([0.0; 3], [3.0, 4.0, 5.0])),
            ("cylinder", Body::cylinder([0.0; 3], 6.0, 10.0)),
            ("cone", Body::cone([0.0; 3], 6.0, 2.0, 10.0)),
        ] {
            let body = body.unwrap();
            let (made, held) = made_and_held(&body);
            assert!(
                farthest(&body, &made) <= Tessellation::default().chord_mm,
                "the {name} is past the chord as the kernel made it"
            );
            assert!(
                held == made,
                "the {name}'s mesh was changed: {} triangles, {} as the kernel made it",
                held.triangles.len(),
                made.triangles.len()
            );
        }
    }

    // the kernel's triangles of a ball of 5 mm are a fifth past the 0.01 mm chord asked, all over it; held to the
    // chord they are within it
    #[test]
    fn a_ball_the_kernel_leaves_past_the_chord_is_brought_within_it() {
        if !crate::KERNEL {
            return;
        }
        let chord = Tessellation::default().chord_mm;
        let ball = Body::sphere([0.0; 3], 5.0).unwrap();
        let (made, held) = made_and_held(&ball);
        let (before, after) = (farthest(&ball, &made), farthest(&ball, &held));
        println!(
            "BALL {} triangles {before:.5} mm as made, {} triangles {after:.5} mm held",
            made.triangles.len(),
            held.triangles.len()
        );
        assert!(
            before > chord,
            "the kernel's ball is within the chord now: {before}"
        );
        assert!(after <= chord, "{after}");
        assert!(held.triangles.len() > made.triangles.len());
        assert!(held.normals.iter().flatten().all(Option::is_some));
    }

    #[test]
    fn a_triangle_keeps_its_normals_only_when_all_three_are_good() {
        let up = v(0.0, 0.0, 1.0);
        let leaning = v(0.6, 0.0, 0.8);
        assert_eq!(
            corner_normals(TRIANGLE, [up, leaning, up]),
            Some([[0.0, 0.0, 1.0], [0.6, 0.0, 0.8], [0.0, 0.0, 1.0]])
        );
        // missing at one corner
        assert_eq!(corner_normals(TRIANGLE, [up, None, up]), None);
        // not finite
        assert_eq!(corner_normals(TRIANGLE, [up, v(f64::NAN, 0.0, 1.0), up]), None);
        assert_eq!(
            corner_normals(TRIANGLE, [up, up, v(0.0, f64::INFINITY, 1.0)]),
            None
        );
        // against the winding, square to it, and no direction at all
        assert_eq!(corner_normals(TRIANGLE, [up, up, v(0.0, 0.0, -1.0)]), None);
        assert_eq!(corner_normals(TRIANGLE, [v(1.0, 0.0, 0.0), up, up]), None);
        assert_eq!(corner_normals(TRIANGLE, [up, v(0.0, 0.0, 0.0), up]), None);
        // a triangle of no area faces no way, so no normal agrees with it
        let flat = [[0.0; 3], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]];
        assert_eq!(corner_normals(flat, [up, up, up]), None);
    }

    #[test]
    fn a_triangle_at_a_cone_s_tip_is_found_by_the_tip_the_kernel_reports() {
        let frame = crate::Frame {
            origin: [0.0; 3],
            x: [1.0, 0.0, 0.0],
            y: [0.0, 1.0, 0.0],
            z: [0.0, 0.0, 1.0],
        };
        let cone = |apex| Surface::Cone {
            frame,
            radius: 10.0,
            half_angle_deg: -45.0,
            apex,
        };
        let tip = [0.0, 0.0, 10.0];
        let touching = [[10.0, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0, 0.0, 10.0 + 1e-12]];
        let below = [[10.0, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0, 0.0, 9.999]];
        assert!(at_tip(Some(&cone(Some(tip))), touching));
        assert!(!at_tip(Some(&cone(Some(tip))), below));
        // a cone cut off below its tip, a cylinder kept as a cone, and other surfaces have no tip on them
        assert!(!at_tip(Some(&cone(None)), touching));
        assert!(!at_tip(Some(&Surface::Sphere { frame, radius: 10.0 }), touching));
        assert!(!at_tip(None, touching));
        // far from the origin the match widens with the coordinates
        let far = [1e6, 0.0, 10.0];
        let near_far = [[1e6 + 5e-4, 0.0, 10.0], [0.0; 3], [1.0; 3]];
        assert!(at_tip(Some(&cone(Some(far))), near_far));
    }

    #[test]
    fn an_edge_s_sides_chain_into_one_run_of_points() {
        // a line seen from both faces, out of order
        assert_eq!(chain(&[[7, 3], [9, 7], [3, 7], [7, 9]]), Some(vec![3, 7, 9]));
        assert_eq!(chain(&[[5, 2]]), Some(vec![2, 5]));
        // a ring starts at its lowest point, heads for the lower neighbor and closes
        assert_eq!(
            chain(&[[4, 8], [8, 6], [6, 1], [1, 4]]),
            Some(vec![1, 4, 8, 6, 1])
        );
        // a fork, two separate pieces, a ring beside a line, a side of no length
        assert_eq!(chain(&[[1, 2], [2, 3], [2, 4]]), None);
        assert_eq!(chain(&[[1, 2], [3, 4]]), None);
        assert_eq!(chain(&[[1, 2], [2, 3], [3, 1], [5, 6]]), None);
        assert_eq!(chain(&[[1, 1]]), None);
    }

    #[test]
    fn edges_are_found_where_faces_meet_and_along_seams() {
        // two triangles on the side from point 0 to point 1
        let triangles = [[0, 1, 2], [1, 0, 3]];
        let one = [[Some(0), Some(1), Some(2)], [Some(1), Some(0), Some(3)]];
        let never = |_: usize, _: [u32; 2]| -> Result<f64> { panic!("no edge needs measuring") };
        // of two faces: the edge between them
        assert_eq!(
            edge_runs(&triangles, &[0, 1], &one, &[[0, 1]], never),
            Ok(vec![vec![0, 1]])
        );
        // of one face, on the same normal records: inside the face, on no edge
        assert_eq!(
            edge_runs(&triangles, &[0, 0], &one, &[[0, 0]], never),
            Ok(vec![vec![]])
        );
        // of one face, on records of their own at both ends: its seam
        let two = [[Some(0), Some(1), Some(2)], [Some(5), Some(4), Some(3)]];
        assert_eq!(
            edge_runs(&triangles, &[0, 0], &two, &[[0, 0]], never),
            Ok(vec![vec![0, 1]])
        );
        // at one end only, as round a pole: not a seam
        let pole = [[Some(0), Some(1), Some(2)], [Some(1), Some(4), Some(3)]];
        assert_eq!(
            edge_runs(&triangles, &[0, 0], &pole, &[[0, 0]], never),
            Ok(vec![vec![]])
        );
        // two edges between the same faces: the nearer one takes the side
        let nearer = |edge: usize, _: [u32; 2]| Ok(if edge == 1 { 0.001 } else { 5.0 });
        assert_eq!(
            edge_runs(&triangles, &[0, 1], &one, &[[1, 0], [0, 1]], nearer),
            Ok(vec![vec![], vec![0, 1]])
        );
        // faces that meet where the body has no edge
        assert_eq!(
            edge_runs(&triangles, &[0, 1], &one, &[[0, 2]], never)
                .err()
                .map(|e| e.to_string()),
            Some("tessellate: triangles of faces 0 and 1 meet where the body has no edge".into())
        );
    }

    #[test]
    fn controls_are_refused_in_words() {
        let with = |change: fn(&mut Tessellation)| {
            let mut how = Tessellation::default();
            change(&mut how);
            how.checked().err().map(|e| e.to_string())
        };
        assert_eq!(with(|_| ()), None);
        assert_eq!(
            with(|h| h.chord_mm = -0.01),
            Some("chord: must be 0 mm or more".into())
        );
        assert_eq!(
            with(|h| h.chord_mm = f64::NAN),
            Some("chord: must be 0 mm or more".into())
        );
        assert_eq!(
            with(|h| h.curve_angle_deg = 91.0),
            Some("curve angle: must be from 0 to 90 degrees".into())
        );
        assert_eq!(
            with(|h| h.surface_angle_deg = -1.0),
            Some("surface angle: must be from 0 to 90 degrees".into())
        );
        assert_eq!(
            with(|h| h.max_edge_mm = -2.0),
            Some("largest edge: must be 0 mm or more".into())
        );
        assert_eq!(
            with(|h| h.max_aspect = f64::INFINITY),
            Some("aspect ratio: must be 0 or more".into())
        );
        assert_eq!(
            with(|h| (h.chord_mm, h.surface_angle_deg) = (0.0, 0.0)),
            Some("chord: give a chord or a surface angle above 0".into())
        );
        // a limit of 0 is off, not an error
        assert_eq!(with(|h| h.chord_mm = 0.0), None);
        assert_eq!(with(|h| h.curve_angle_deg = 0.0), None);
    }
}
