// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! solid builders
// ring indices come from the polygons being extruded
#![allow(clippy::indexing_slicing)]

use crate::error::Result;
use crate::faces::{self, Faces, Surface};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d::{self, Polygon};
use crate::vec3;
use crate::vec3::{Frame, V2, V3};

pub fn box_mesh(min: V3, max: V3) -> TriMesh {
    let p = |x: usize, y: usize, z: usize| {
        [
            if x == 0 { min[0] } else { max[0] },
            if y == 0 { min[1] } else { max[1] },
            if z == 0 { min[2] } else { max[2] },
        ]
    };
    let positions = vec![
        p(0, 0, 0),
        p(1, 0, 0),
        p(1, 1, 0),
        p(0, 1, 0),
        p(0, 0, 1),
        p(1, 0, 1),
        p(1, 1, 1),
        p(0, 1, 1),
    ];
    let triangles = vec![
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    // Two triangles a side, in the order above: bottom, top, front (min y), right (max x), back, left.
    let table = vec![
        faces::box_plane(2, false, min[2]),
        faces::box_plane(2, true, max[2]),
        faces::box_plane(1, false, min[1]),
        faces::box_plane(0, true, max[0]),
        faces::box_plane(1, true, max[1]),
        faces::box_plane(0, false, min[0]),
    ];
    TriMesh {
        positions,
        triangles,
        faces: Some(Faces {
            ids: (0..12).map(|t| t / 2).collect(),
            table,
        }),
    }
}

/// A straight extrusion, with its faces: the two caps are planes, a straight side is a plane and a run of sides
/// along a tessellated arc is one cylinder.
pub fn extrude(polys: &[Polygon], frame: &Frame, h0: f64, h1: f64) -> Result<TriMesh> {
    let mut faces = Faces::default();
    let mut m = sweep(polys, frame, h0, h1, |p, _| p, Some(&mut faces))?;
    m.faces = Some(faces::merge_meeting_planes(&m, faces));
    Ok(m)
}

/// Polygons swept from `h0` to `h1`, each top vertex placed by `top`. The faces are left out, since `top` may twist
/// the sides; `extrude` has them.
pub fn loft(
    polys: &[Polygon],
    frame: &Frame,
    h0: f64,
    h1: f64,
    top: impl Fn(V2, usize) -> V2,
) -> Result<TriMesh> {
    sweep(polys, frame, h0, h1, top, None)
}

fn sweep(
    polys: &[Polygon],
    frame: &Frame,
    h0: f64,
    h1: f64,
    top: impl Fn(V2, usize) -> V2,
    mut faces: Option<&mut Faces>,
) -> Result<TriMesh> {
    let up = if h1 >= h0 { 1.0 } else { -1.0 };
    let mut m = TriMesh::default();
    for poly in polys {
        let mut poly = poly.clone();
        poly.normalize_orientation();
        let tris = poly2d::triangulate(&poly)?;
        let pts: Vec<V2> = poly.vertices().collect();
        #[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
        let (b, n) = (m.positions.len() as u32, pts.len() as u32);
        m.positions.extend(pts.iter().map(|&p| frame.at(p, h0)));
        m.positions
            .extend(pts.iter().enumerate().map(|(i, &p)| frame.at(top(p, i), h1)));
        for t in &tris {
            m.triangles.push([b + t[0], b + t[2], b + t[1]]);
            m.triangles.push([b + n + t[0], b + n + t[1], b + n + t[2]]);
        }
        if let Some(f) = faces.as_deref_mut() {
            let cap = |h: f64, sign: f64| {
                let normal = vec3::scale(frame.w, sign * up);
                Surface::Plane {
                    normal,
                    offset: vec3::dot(normal, frame.at([0.0, 0.0], h)),
                }
            };
            let (bottom, lid) = (f.push(cap(h0, -1.0)), f.push(cap(h1, 1.0)));
            for _ in &tris {
                f.ids.extend([bottom, lid]);
            }
        }
        let mut start = 0u32;
        for ring in std::iter::once(&poly.outer).chain(&poly.holes) {
            #[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
            let len = ring.len() as u32;
            for k in 0..len {
                let (i, j) = (b + start + k, b + start + (k + 1) % len);
                m.triangles.push([i, j, j + n]);
                m.triangles.push([i, j + n, i + n]);
            }
            if let Some(f) = faces.as_deref_mut() {
                for id in side_faces(ring, frame, h0, up, f) {
                    f.ids.extend([id, id]);
                }
            }
            start += len;
        }
    }
    Ok(m)
}

/// The center of the circle through three points, or none when they lie on a line.
fn circumcenter(a: V2, b: V2, c: V2) -> Option<V2> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if d.abs() < 1e-18 {
        return None;
    }
    let (sa, sb, sc) = (
        a[0] * a[0] + a[1] * a[1],
        b[0] * b[0] + b[1] * b[1],
        c[0] * c[0] + c[1] * c[1],
    );
    Some([
        (sa * (b[1] - c[1]) + sb * (c[1] - a[1]) + sc * (a[1] - b[1])) / d,
        (sa * (c[0] - b[0]) + sb * (a[0] - c[0]) + sc * (b[0] - a[0])) / d,
    ])
}

/// Turns no sharper than this between two sides still follow one arc (a circle has at least 12 sides).
const ARC_TURN_DEG: f64 = 30.0;

/// The face of each side of `ring` (side `k` runs from vertex `k` to the next), pushed to `f`: a plane for a
/// straight side, one cylinder for a run of sides along an arc. Outer rings run counterclockwise and holes
/// clockwise, so the outward side is on the right of each side in both.
fn side_faces(ring: &[V2], frame: &Frame, h0: f64, up: f64, f: &mut Faces) -> Vec<u32> {
    ring_faces(
        ring,
        f,
        |(center, radius)| Surface::Cylinder {
            origin: frame.at(center, h0),
            axis: frame.w,
            radius,
        },
        |a, b| {
            let d = [b[0] - a[0], b[1] - a[1]];
            let out2 = [d[1] * up, -d[0] * up];
            let normal = vec3::normalize(vec3::add(
                vec3::scale(frame.u, out2[0]),
                vec3::scale(frame.v, out2[1]),
            ))
            .unwrap_or(frame.u);
            Surface::Plane {
                normal,
                offset: vec3::dot(normal, frame.at(a, h0)),
            }
        },
    )
}

/// The face of each side of the closed `ring`, pushed to `f`: a run of sides along a tessellated arc is one face,
/// `arc` of its circle (center and radius); any other side is a face of its own, `straight` of its two ends.
pub(crate) fn ring_faces(
    ring: &[V2],
    f: &mut Faces,
    arc: impl Fn((V2, f64)) -> Surface,
    straight: impl Fn(V2, V2) -> Surface,
) -> Vec<u32> {
    let len = ring.len();
    let at = |k: usize| ring[k % len];
    let (on_arc, tol) = arcs(ring);
    let same = |a: Circle, b: Circle| same_circle(a, b, tol);
    let mut ids = Vec::with_capacity(len);
    let mut last: Option<((V2, f64), u32)> = None;
    for (k, side) in on_arc.iter().enumerate() {
        let id = if let Some(c) = *side {
            match last {
                Some((lc, id)) if same(lc, c) => id,
                _ => {
                    let id = f.push(arc(c));
                    last = Some((c, id));
                    id
                }
            }
        } else {
            last = None;
            f.push(straight(at(k), at(k + 1)))
        };
        ids.push(id);
    }
    // A ring that is all one arc may have started a second face for the same circle at side 0.
    if let (Some(c0), Some(cn)) = (on_arc[0], on_arc[len - 1])
        && same(c0, cn)
        && ids[0] != ids[len - 1]
    {
        let (keep, drop) = (ids[len - 1], ids[0]);
        for id in &mut ids {
            if *id == drop {
                *id = keep;
            }
        }
    }
    ids
}

/// For each side of the closed `ring`, the circle (center and radius) of the tessellated arc it lies on, if any,
/// and a test for two circles being the same within the ring's tolerance.
fn arcs(ring: &[V2]) -> (Vec<Option<Circle>>, f64) {
    let len = ring.len();
    let at = |k: usize| ring[k % len];
    let size = ring
        .iter()
        .fold(0.0_f64, |m, p| m.max(p[0].abs()).max(p[1].abs()))
        .max(1.0);
    let tol = size * 1e-7;
    let max_turn = ARC_TURN_DEG.to_radians().m_sin() + 1e-9;
    // The circle through the ends of side k and the end of side k + 1, when they turn gently.
    let circle = |k: usize| -> Option<(V2, f64)> {
        let (a, b, c) = (at(k), at(k + 1), at(k + 2));
        let (d1, d2) = ([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]);
        let (l1, l2) = (d1[0].m_hypot(d1[1]), d2[0].m_hypot(d2[1]));
        // The sides of a tessellated arc are about equally long; a long straight side between two rounds is not
        // part of either, though the four points around it may lie on one circle.
        if l1 <= tol || l2 <= tol || l1 > 2.0 * l2 || l2 > 2.0 * l1 {
            return None;
        }
        let sin = (d1[0] * d2[1] - d1[1] * d2[0]) / (l1 * l2);
        let cos = (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2);
        if cos <= 0.0 || sin.abs() > max_turn || sin.abs() < 1e-6 {
            return None;
        }
        circumcenter(a, b, c).map(|o| (o, (a[0] - o[0]).m_hypot(a[1] - o[1])))
    };
    let circles: Vec<Option<(V2, f64)>> = (0..len).map(circle).collect();
    let same = |a: Circle, b: Circle| same_circle(a, b, tol);
    let same_opt =
        |x: Option<(V2, f64)>, y: Option<(V2, f64)>| matches!((x, y), (Some(a), Some(b)) if same(a, b));
    // Side k is on an arc when the circle through it and the next side matches the one through the previous side
    // and it, or it is the first or last side of such a run.
    let on_arc = (0..len)
        .map(|k| {
            let prev = circles[(k + len - 1) % len];
            let here = circles[k];
            if same_opt(prev, here) || same_opt(here, circles[(k + 1) % len]) {
                here
            } else if same_opt(circles[(k + len - 2) % len], prev) {
                prev
            } else {
                None
            }
        })
        .collect();
    (on_arc, tol)
}

/// A circle in the plane: center and radius.
type Circle = (V2, f64);

fn same_circle((o1, r1): Circle, (o2, r2): Circle, tol: f64) -> bool {
    (o1[0] - o2[0]).m_hypot(o1[1] - o2[1]) <= tol * 10.0 && (r1 - r2).abs() <= tol * 10.0
}

pub fn cylinder(frame: &Frame, r: f64, h0: f64, h1: f64, segments: usize) -> TriMesh {
    let poly = Polygon::simple(poly2d::circle([0.0, 0.0], r, segments));
    extrude(&[poly], frame, h0, h1).unwrap_or_default()
}

/// number of segments for a circle of radius `r` with a chord error below `tolerance` mm, clamped to 12..=128
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to a small positive range"
)]
pub fn circle_segments(r: f64, tolerance: f64) -> usize {
    if r <= 0.0 || tolerance <= 0.0 {
        return 12;
    }
    let half = (1.0 - (tolerance / r).min(1.0)).m_acos();
    if half <= 0.0 {
        return 128;
    }
    ((std::f64::consts::PI / half).ceil() as usize).clamp(12, 128)
}

#[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
pub fn uv_sphere(center: V3, r: f64, rings: usize, segments: usize) -> TriMesh {
    let (rings, segs) = (rings.max(2), segments.max(3));
    let mut m = TriMesh::default();
    let south = m.push_vertex([center[0], center[1], center[2] - r]);
    for i in 1..rings {
        let phi = std::f64::consts::PI * i as f64 / rings as f64 - std::f64::consts::FRAC_PI_2;
        for j in 0..segs {
            let th = std::f64::consts::TAU * j as f64 / segs as f64;
            m.push_vertex([
                center[0] + r * phi.m_cos() * th.m_cos(),
                center[1] + r * phi.m_cos() * th.m_sin(),
                center[2] + r * phi.m_sin(),
            ]);
        }
    }
    let north = m.push_vertex([center[0], center[1], center[2] + r]);
    let at = |i: usize, j: usize| (1 + (i - 1) * segs + j % segs) as u32;
    for j in 0..segs {
        m.triangles.push([south, at(1, j + 1), at(1, j)]);
        m.triangles.push([north, at(rings - 1, j), at(rings - 1, j + 1)]);
    }
    for i in 1..rings - 1 {
        for j in 0..segs {
            m.triangles.push([at(i, j), at(i, j + 1), at(i + 1, j + 1)]);
            m.triangles.push([at(i, j), at(i + 1, j + 1), at(i + 1, j)]);
        }
    }
    m
}

#[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
pub fn torus(center: V3, big: f64, small: f64, n_major: usize, n_minor: usize) -> TriMesh {
    let (na, nb) = (n_major.max(3), n_minor.max(3));
    let mut m = TriMesh::default();
    for i in 0..na {
        let a = std::f64::consts::TAU * i as f64 / na as f64;
        for j in 0..nb {
            let b = std::f64::consts::TAU * j as f64 / nb as f64;
            let rr = big + small * b.m_cos();
            m.push_vertex([
                center[0] + rr * a.m_cos(),
                center[1] + rr * a.m_sin(),
                center[2] + small * b.m_sin(),
            ]);
        }
    }
    let at = |i: usize, j: usize| ((i % na) * nb + j % nb) as u32;
    for i in 0..na {
        for j in 0..nb {
            m.triangles.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)]);
            m.triangles.push([at(i, j), at(i + 1, j + 1), at(i, j + 1)]);
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn procedural_test_solids_are_closed() {
        let s = uv_sphere([0.0; 3], 10.0, 40, 80);
        assert!(s.edge_report().is_watertight());
        let v = 4.0 / 3.0 * std::f64::consts::PI * 1000.0;
        assert!((s.volume() - v).abs() / v < 0.01);
        let t = torus([0.0; 3], 20.0, 6.0, 150, 100);
        assert_eq!(t.triangles.len(), 30_000);
        assert!(t.edge_report().is_watertight());
        assert!(t.volume() > 0.0);
    }

    #[test]
    fn extruded_ring_is_watertight() {
        let mut hole = poly2d::circle([0.0, 0.0], 2.0, 24);
        hole.reverse();
        let poly = Polygon {
            outer: poly2d::circle([0.0, 0.0], 5.0, 32),
            holes: vec![hole],
        };
        let m = extrude(std::slice::from_ref(&poly), &Frame::WORLD, 0.0, 3.0).unwrap();
        assert!(m.edge_report().is_watertight());
        assert!((m.volume() - poly.area() * 3.0).abs() < 1e-9);
    }

    #[test]
    fn tilted_cylinder_has_positive_volume() {
        let f = Frame::from_normal([1.0, 2.0, 3.0], [1.0, 1.0, 0.0], None).unwrap();
        let m = cylinder(&f, 2.0, -1.0, 4.0, 40);
        assert!(m.edge_report().is_watertight());
        assert!(m.volume() > 0.0);
    }
}
