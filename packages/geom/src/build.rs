// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! solid builders
// ring indices come from the polygons being extruded
#![allow(clippy::indexing_slicing)]

use crate::error::Result;
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d::{self, Polygon};
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
    TriMesh::new(positions, triangles)
}

pub fn extrude(polys: &[Polygon], frame: &Frame, h0: f64, h1: f64) -> Result<TriMesh> {
    loft(polys, frame, h0, h1, |p, _| p)
}

pub fn loft(
    polys: &[Polygon],
    frame: &Frame,
    h0: f64,
    h1: f64,
    top: impl Fn(V2, usize) -> V2,
) -> Result<TriMesh> {
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
        let mut start = 0u32;
        for ring in std::iter::once(&poly.outer).chain(&poly.holes) {
            #[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
            let len = ring.len() as u32;
            for k in 0..len {
                let (i, j) = (b + start + k, b + start + (k + 1) % len);
                m.triangles.push([i, j, j + n]);
                m.triangles.push([i, j + n, i + n]);
            }
            start += len;
        }
    }
    Ok(m)
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
