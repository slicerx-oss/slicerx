// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The typed tessellation of the four primitives: closed on the kernel's own shared vertices, each triangle on its
// face, corner normals that match the exact surface, an edge table, and controls that each change the result.
#![cfg(sx_brep_kernel)]
use std::collections::HashMap;
use std::f64::consts::PI;
use sx_brep::{Body, Curve, Mesh, Surface, Tessellation};

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

fn unit(a: [f64; 3]) -> [f64; 3] {
    let l = dot(a, a).sqrt();
    a.map(|c| c / l)
}

/// The angle between two unit vectors in degrees.
fn angle(a: [f64; 3], b: [f64; 3]) -> f64 {
    let c = cross(a, b);
    dot(c, c).sqrt().atan2(dot(a, b)).to_degrees()
}

fn mesh(body: &Body) -> Mesh {
    body.tessellate(&Tessellation::default()).expect("a mesh")
}

/// Checks what holds for any body's mesh, with no welding: the tables line up, every index is in range, and each
/// side of a triangle is shared with exactly one other triangle, running the other way. Returns the mesh volume.
fn closed_volume(m: &Mesh) -> f64 {
    assert_eq!(m.faces.len(), m.triangles.len());
    assert_eq!(m.normals.len(), m.triangles.len());
    assert!(m.faces.iter().all(|&f| (f as usize) < m.surfaces.len()));
    let mut sides: HashMap<(u32, u32), (i32, i32)> = HashMap::new();
    let mut volume = 0.0;
    for t in &m.triangles {
        assert!(t.iter().all(|&i| (i as usize) < m.positions.len()));
        assert!(
            t[0] != t[1] && t[1] != t[2] && t[2] != t[0],
            "a triangle repeats a vertex"
        );
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let side = sides.entry((a.min(b), a.max(b))).or_default();
            side.0 += 1;
            side.1 += if a < b { 1 } else { -1 };
        }
        let [a, b, c] = t.map(|i| m.positions[i as usize]);
        volume += dot(a, cross(b, c)) / 6.0;
    }
    let open = sides.values().filter(|&&s| s != (2, 0)).count();
    assert_eq!(open, 0, "sides not shared by two triangles running opposite ways");
    volume
}

/// Checks the edge table against the triangles: every point of an edge is a mesh vertex, each step along it is a
/// side of a triangle of each of its two faces, and its faces are in the face table.
fn edges_follow_the_triangles(m: &Mesh) {
    let mut sides: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
    for (t, &face) in m.triangles.iter().zip(&m.faces) {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            sides.entry((a.min(b), a.max(b))).or_default().push(face);
        }
    }
    for (i, edge) in m.edges.iter().enumerate() {
        assert!(edge.faces.iter().all(|&f| (f as usize) < m.surfaces.len()));
        for step in edge.points.windows(2) {
            let on = sides
                .get(&(step[0].min(step[1]), step[0].max(step[1])))
                .unwrap_or_else(|| panic!("edge {i}: step {step:?} is no triangle side"));
            let mut on = on.clone();
            on.sort_unstable();
            let mut joined = edge.faces.to_vec();
            joined.sort_unstable();
            assert_eq!(on, joined, "edge {i}: step {step:?}");
        }
    }
}

#[test]
fn a_box_is_twelve_triangles_on_eight_shared_vertices() {
    let body = Body::cuboid([1.0, 2.0, 3.0], [20.0, 30.0, 40.0]).unwrap();
    let m = mesh(&body);
    assert_eq!(m.triangles.len(), 12);
    assert_eq!(
        m.positions.len(),
        8,
        "the kernel shares each corner between its three faces"
    );
    assert!((closed_volume(&m) - 24000.0).abs() < 1e-6);
    assert_eq!(m.surfaces.len(), 6);
    assert!(m.surfaces.iter().all(|s| matches!(s, Surface::Plane { .. })));
    // two triangles on each face, and at every corner the normal of the flat face they lie on
    for face in 0..6 {
        assert_eq!(m.faces.iter().filter(|&&f| f == face).count(), 2);
    }
    for ((t, normals), &face) in m.triangles.iter().zip(&m.normals).zip(&m.faces) {
        let [a, b, c] = t.map(|i| m.positions[i as usize]);
        let flat = unit(cross(sub(b, a), sub(c, a)));
        let normals = normals.expect("a flat face has its normals");
        assert!(normals.iter().all(|&n| angle(n, flat) < 1e-6));
        // the plane in the face table is the same plane, facing either way
        let Surface::Plane { frame } = m.surfaces[face as usize] else {
            unreachable!()
        };
        assert!(angle(frame.z, flat).min(180.0 - angle(frame.z, flat)) < 1e-6);
        assert!(dot(sub(a, frame.origin), frame.z).abs() < 1e-9);
    }
    // twelve sharp straight edges, each two corners, each between two different faces
    assert_eq!(m.edges.len(), 12);
    for edge in &m.edges {
        assert_eq!(edge.curve, Curve::Line);
        assert!(!edge.tangent);
        assert_ne!(edge.faces[0], edge.faces[1]);
        assert_eq!(edge.points.len(), 2);
        assert!(edge.points[0] < edge.points[1]);
    }
    edges_follow_the_triangles(&m);
}

#[test]
fn a_cylinder_s_normals_are_the_exact_ones() {
    let body = Body::cylinder([5.0, -4.0, 2.0], 10.0, 20.0).unwrap();
    let m = mesh(&body);
    let exact = PI * 100.0 * 20.0;
    let volume = closed_volume(&m);
    assert!(volume < exact && volume > exact * 0.995, "{volume}");
    let mut round = 0;
    for ((t, normals), &face) in m.triangles.iter().zip(&m.normals).zip(&m.faces) {
        let normals = normals.expect("every corner of a cylinder has a normal");
        let flat = matches!(m.surfaces[face as usize], Surface::Plane { .. });
        round += usize::from(!flat);
        for (&i, n) in t.iter().zip(normals) {
            let p = m.positions[i as usize];
            let want = if flat {
                [0.0, 0.0, if p[2] > 12.0 { 1.0 } else { -1.0 }]
            } else {
                unit([p[0] - 5.0, p[1] + 4.0, 0.0])
            };
            assert!(angle(n, want) < 1e-4, "{n:?} at {p:?}, expected {want:?}");
        }
    }
    assert!(round > 0);
    // the two rims are closed rings between the wall and a flat end, and sharp
    let rims: Vec<_> = m.edges.iter().filter(|e| e.faces[0] != e.faces[1]).collect();
    assert_eq!(rims.len(), 2, "{:?}", m.edges);
    for rim in rims {
        assert!(!rim.tangent);
        assert_eq!(rim.points.first(), rim.points.last());
        assert!(rim.points.len() > 12);
        let z = m.positions[rim.points[0] as usize][2];
        assert!((z - 2.0).abs() < 1e-9 || (z - 22.0).abs() < 1e-9);
        for &p in &rim.points {
            let p = m.positions[p as usize];
            assert!((p[2] - z).abs() < 1e-9);
            assert!(((p[0] - 5.0).hypot(p[1] + 4.0) - 10.0).abs() < 1e-9);
        }
    }
    // the wall meets itself along one straight seam from rim to rim, and smoothly
    let seams: Vec<_> = m.edges.iter().filter(|e| e.faces[0] == e.faces[1]).collect();
    assert_eq!(seams.len(), 1, "{:?}", m.edges);
    assert!(seams[0].tangent);
    assert_eq!(seams[0].curve, Curve::Line);
    let [low, high] = seams[0].points[..] else {
        panic!("a straight seam is two points, not {:?}", seams[0].points);
    };
    let (low, high) = (m.positions[low as usize], m.positions[high as usize]);
    assert!((low[0] - high[0]).abs() < 1e-9 && (low[1] - high[1]).abs() < 1e-9);
    assert!(((low[2] - high[2]).abs() - 20.0).abs() < 1e-9);
    edges_follow_the_triangles(&m);
}

#[test]
fn a_cone_s_tip_has_no_normal_and_the_rest_of_it_does() {
    let body = Body::cone([0.0; 3], 10.0, 0.0, 10.0).unwrap();
    let m = mesh(&body);
    let exact = PI * 100.0 * 10.0 / 3.0;
    let volume = closed_volume(&m);
    assert!(volume < exact && volume > exact * 0.99, "{volume}");
    let tip = |p: [f64; 3]| p[0].hypot(p[1]) < 1e-9 && (p[2] - 10.0).abs() < 1e-9;
    let (mut with, mut without) = (0, 0);
    for ((t, normals), &face) in m.triangles.iter().zip(&m.normals).zip(&m.faces) {
        let corners = t.map(|i| m.positions[i as usize]);
        let on_cone = matches!(m.surfaces[face as usize], Surface::Cone { .. });
        let at_tip = on_cone && corners.iter().any(|&p| tip(p));
        // one direction cannot be the normal all round the tip, so a triangle there has none
        let Some(normals) = normals else {
            without += 1;
            assert!(at_tip, "no normal away from the tip");
            continue;
        };
        with += 1;
        assert!(!at_tip, "a normal at the tip");
        for (p, n) in corners.iter().zip(normals) {
            let want = if on_cone {
                let r = p[0].hypot(p[1]);
                unit([p[0] / r, p[1] / r, 1.0])
            } else {
                [0.0, 0.0, -1.0]
            };
            assert!(angle(*n, want) < 1e-4, "{n:?} at {p:?}, expected {want:?}");
        }
    }
    assert!(with > 0 && without > 0, "{with} with, {without} without");
    edges_follow_the_triangles(&m);
}

#[test]
fn a_sphere_s_normals_point_from_its_center() {
    let center = [3.0, -2.0, 7.0];
    let body = Body::sphere(center, 10.0).unwrap();
    let m = mesh(&body);
    let exact = 4.0 / 3.0 * PI * 1000.0;
    let volume = closed_volume(&m);
    assert!(volume < exact && volume > exact * 0.995, "{volume}");
    assert_eq!(m.surfaces.len(), 1);
    let mut with = 0;
    for (t, normals) in m.triangles.iter().zip(&m.normals) {
        let Some(normals) = normals else { continue };
        with += 1;
        for (&i, n) in t.iter().zip(normals) {
            let want = unit(sub(m.positions[i as usize], center));
            assert!(angle(*n, want) < 1e-4);
        }
    }
    // nearly all of it; a triangle may go without only where the kernel's normal fails the winding check
    assert!(
        with * 100 >= m.triangles.len() * 99,
        "{with} of {}",
        m.triangles.len()
    );
    // its one edge is the seam, half a great circle from pole to pole
    let [seam] = &m.edges[..] else {
        panic!("a sphere has one edge, not {:?}", m.edges.len());
    };
    assert!(seam.tangent && seam.faces == [0, 0]);
    assert_eq!(seam.curve, Curve::Circle);
    let (first, last) = (seam.points[0], seam.points[seam.points.len() - 1]);
    let pole = |p: u32| sub(m.positions[p as usize], center);
    assert!((pole(first)[2].abs() - 10.0).abs() < 1e-9 && (pole(last)[2].abs() - 10.0).abs() < 1e-9);
    assert!((pole(first)[2] + pole(last)[2]).abs() < 1e-9);
    assert!(seam.points.len() > 12);
    edges_follow_the_triangles(&m);
}

#[test]
fn each_control_changes_the_mesh() {
    let ball = Body::sphere([0.0; 3], 10.0).unwrap();
    let count = |body: &Body, how: Tessellation| body.tessellate(&how).expect("a mesh").triangles.len();
    let coarse = Tessellation {
        chord_mm: 0.5,
        curve_angle_deg: 0.0,
        surface_angle_deg: 0.0,
        max_edge_mm: 0.0,
        max_aspect: 0.0,
    };
    let base = count(&ball, coarse);
    // a tighter chord
    assert!(
        count(
            &ball,
            Tessellation {
                chord_mm: 0.05,
                ..coarse
            }
        ) > base
    );
    // a surface angle
    assert!(
        count(
            &ball,
            Tessellation {
                surface_angle_deg: 5.0,
                ..coarse
            }
        ) > base
    );
    // a largest edge, which splits even the flat faces of a box
    let block = Body::cuboid([0.0; 3], [20.0; 3]).unwrap();
    assert_eq!(count(&block, coarse), 12);
    assert!(
        count(
            &block,
            Tessellation {
                max_edge_mm: 5.0,
                ..coarse
            }
        ) > 12
    );
    // a curve angle, which puts more points on a cylinder's rims
    let post = Body::cylinder([0.0; 3], 10.0, 20.0).unwrap();
    let rim_points = |how: Tessellation| {
        let m = post.tessellate(&how).expect("a mesh");
        m.edges.iter().map(|e| e.points.len()).max().unwrap_or(0)
    };
    assert!(
        rim_points(Tessellation {
            curve_angle_deg: 5.0,
            ..coarse
        }) > rim_points(coarse)
    );
    // an aspect ratio, which the kernel takes up on the ball once it is tight enough
    assert_ne!(
        count(
            &ball,
            Tessellation {
                max_aspect: 1.1,
                ..coarse
            }
        ),
        base
    );
}
