// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the real outline of a part on the bed: the union of its triangles seen from above

use super::poly::{self, Region, Ring};
use crate::mesh::TriMesh;

/// a column major 4x4 transform, as the app keeps them
pub type Mat4 = [f64; 16];

#[derive(Debug, Clone, Copy)]
pub struct SilhouetteOptions {
    /// how far the simplified outline may lie outside the true one, mm
    pub tolerance_mm: f64,
    /// holes smaller than this are filled, mm2
    pub min_hole_mm2: f64,
    /// past this many vertices the tolerance doubles until it fits
    pub max_vertices: usize,
}

impl Default for SilhouetteOptions {
    fn default() -> Self {
        Self {
            tolerance_mm: 0.1,
            min_hole_mm2: 1.0,
            max_vertices: 1500,
        }
    }
}

fn apply(m: &Mat4, p: [f64; 3]) -> [f64; 2] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    ]
}

/// what a part covers seen from above
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Silhouette {
    /// holes kept, simplified so it still covers the part
    pub outline: Region,
    /// the exact convex hull
    pub hull: Ring,
}

/// the outline of every mesh seen from above after `transform`, holes kept
pub fn silhouette(meshes: &[TriMesh], transform: Option<&Mat4>, opts: &SilhouetteOptions) -> Silhouette {
    let id: Mat4 = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    let m = transform.unwrap_or(&id);
    let mut tris: Vec<Ring> = Vec::new();
    for mesh in meshes {
        let flat: Vec<[f64; 2]> = mesh.positions.iter().map(|p| apply(m, *p)).collect();
        for t in &mesh.triangles {
            let (Some(a), Some(b), Some(c)) = (
                flat.get(t[0] as usize),
                flat.get(t[1] as usize),
                flat.get(t[2] as usize),
            ) else {
                continue;
            };
            let o = poly::cross(*a, *b, *c);
            if o.abs() < 1e-9 {
                continue;
            }
            tris.push(if o > 0.0 {
                vec![*a, *b, *c]
            } else {
                vec![*a, *c, *b]
            });
        }
    }
    let mut out = poly::union_rings(&tris);
    let hull = poly::hull(
        &out.iter()
            .flat_map(|s| s.first().cloned().unwrap_or_default())
            .collect::<Vec<_>>(),
    );
    for s in &mut out {
        let mut k = 0;
        s.retain(|ring| {
            k += 1;
            k == 1 || crate::poly2d::signed_area(ring).abs() >= opts.min_hole_mm2
        });
    }
    let mut tol = opts.tolerance_mm;
    let mut simple = poly::cover(&out, tol);
    while poly::vertex_count(&simple) > opts.max_vertices && tol < 5.0 {
        tol *= 2.0;
        simple = poly::cover(&out, tol);
    }
    Silhouette {
        outline: simple,
        hull,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vec3::V3;

    /// a box from min to max
    fn block(min: V3, max: V3) -> TriMesh {
        let c = |i: usize| -> V3 {
            [
                if i & 1 == 0 { min[0] } else { max[0] },
                if i & 2 == 0 { min[1] } else { max[1] },
                if i & 4 == 0 { min[2] } else { max[2] },
            ]
        };
        let positions = (0..8).map(c).collect();
        let triangles = vec![
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ];
        TriMesh::new(positions, triangles)
    }

    #[test]
    fn an_l_keeps_its_inner_corner() {
        let mut m = block([0.0, 0.0, 0.0], [40.0, 10.0, 5.0]);
        m.append(&block([0.0, 0.0, 0.0], [10.0, 40.0, 5.0]));
        let s = silhouette(&[m], None, &SilhouetteOptions::default()).outline;
        assert_eq!(s.len(), 1);
        let a = poly::area(&s);
        assert!(a > 700.0 && a < 720.0, "{a}");
        assert!(!poly::strictly_inside(&s, [25.0, 25.0], 0.0));
    }

    #[test]
    fn an_overhang_widens_the_outline() {
        // a mushroom: a thin stem under a wide cap
        let mut m = block([-2.0, -2.0, 0.0], [2.0, 2.0, 10.0]);
        m.append(&block([-10.0, -10.0, 10.0], [10.0, 10.0, 12.0]));
        let s = silhouette(&[m], None, &SilhouetteOptions::default());
        let b = poly::bbox(&s.outline);
        assert!(b.w() > 20.0 && b.w() < 20.3);
        let h = poly::ring_bbox(&s.hull);
        assert!((h.w() - 20.0).abs() < 1e-6);
    }

    #[test]
    fn a_turned_transform_turns_the_outline() {
        let m = block([0.0, 0.0, 0.0], [30.0, 10.0, 5.0]);
        // a quarter turn about z, then 100 mm along x
        let t: Mat4 = [
            0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 100.0, 0.0, 0.0, 1.0,
        ];
        let s = silhouette(&[m], Some(&t), &SilhouetteOptions::default()).outline;
        let b = poly::bbox(&s);
        assert!((b.w() - 10.0).abs() < 0.3 && (b.h() - 30.0).abs() < 0.3);
        assert!((b.min[0] - 90.0).abs() < 0.2);
    }
}
