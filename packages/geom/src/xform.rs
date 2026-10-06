// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! affine transforms in the layout three.js and the plate use

use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::vec3::{self, V3};

/// a 4 x 4 column-major matrix; the last row is assumed `0 0 0 1`
pub type Mat4 = [f64; 16];

pub const IDENTITY: Mat4 = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

pub fn apply(m: &Mat4, p: V3) -> V3 {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ]
}

pub fn apply_dir(m: &Mat4, d: V3) -> V3 {
    [
        m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
        m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
        m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
    ]
}

pub fn det(m: &Mat4) -> f64 {
    vec3::dot(
        [m[0], m[1], m[2]],
        vec3::cross([m[4], m[5], m[6]], [m[8], m[9], m[10]]),
    )
}

pub fn mul(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [0.0; 16];
    let a_cols = a.as_chunks::<4>().0;
    for (oc, bc) in out.as_chunks_mut::<4>().0.iter_mut().zip(b.as_chunks::<4>().0) {
        for (ac, &bk) in a_cols.iter().zip(bc) {
            for (o, &av) in oc.iter_mut().zip(ac) {
                *o += av * bk;
            }
        }
    }
    out
}

pub fn invert(m: &Mat4) -> Option<Mat4> {
    let d = det(m);
    if !(d.is_finite() && d.abs() > 1e-15) {
        return None;
    }
    let (a, b, c) = ([m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]);
    let r0 = vec3::scale(vec3::cross(b, c), 1.0 / d);
    let r1 = vec3::scale(vec3::cross(c, a), 1.0 / d);
    let r2 = vec3::scale(vec3::cross(a, b), 1.0 / d);
    let t = [m[12], m[13], m[14]];
    let ti = [-vec3::dot(r0, t), -vec3::dot(r1, t), -vec3::dot(r2, t)];
    Some([
        r0[0], r1[0], r2[0], 0.0, r0[1], r1[1], r2[1], 0.0, r0[2], r1[2], r2[2], 0.0, ti[0], ti[1], ti[2],
        1.0,
    ])
}

pub fn translation(d: V3) -> Mat4 {
    let mut m = IDENTITY;
    m[12] = d[0];
    m[13] = d[1];
    m[14] = d[2];
    m
}

pub fn rotation_about(center: V3, axis: V3, angle: f64) -> Mat4 {
    let [x, y, z] = axis;
    let (s, c) = angle.m_sin_cos();
    let t = 1.0 - c;
    let r = [
        t * x * x + c,
        t * x * y + s * z,
        t * x * z - s * y,
        0.0,
        t * x * y - s * z,
        t * y * y + c,
        t * y * z + s * x,
        0.0,
        t * x * z + s * y,
        t * y * z - s * x,
        t * z * z + c,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
    ];
    mul(
        &translation(center),
        &mul(&r, &translation(vec3::scale(center, -1.0))),
    )
}

pub fn transformed(mesh: &TriMesh, m: &Mat4) -> TriMesh {
    let mut out = mesh.clone();
    out.map_positions(|p| apply(m, p));
    out.faces = mesh.faces.as_ref().map(|f| f.transformed(m));
    if det(m) < 0.0 {
        out.flip();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn faces_move_with_a_rigid_move_and_a_mirror() {
        let cut = crate::boolean::boolean(
            &[crate::build::box_mesh([0.0; 3], [10.0; 3])],
            &[crate::build::box_mesh([3.0, 3.0, 2.0], [7.0, 7.0, 10.0])],
            crate::boolean::BoolOp::Difference,
            &crate::boolean::BooleanOptions::default(),
        )
        .unwrap()
        .0;
        let turn = mul(
            &rotation_about([1.0, 2.0, 3.0], [0.3, -0.5, 0.8], 1.1),
            &translation([4.0, -7.0, 2.5]),
        );
        let mirror = [
            -1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        for m in [turn, mirror, mul(&turn, &mirror)] {
            let moved = transformed(&cut, &m);
            assert_eq!(crate::faces::check::faces_agree(&moved), 11);
        }
    }

    #[test]
    fn a_stretch_keeps_planes_and_forgets_cylinders() {
        use crate::faces::Surface;
        let s = Surface::Cylinder {
            origin: [0.0; 3],
            axis: [0.0, 0.0, 1.0],
            radius: 2.0,
        };
        let stretch = [
            2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        assert_eq!(s.transformed(&stretch), Surface::Other);
        let grow = [
            3.0, 0.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 3.0, 0.0, 1.0, 1.0, 1.0, 1.0,
        ];
        assert_eq!(
            s.transformed(&grow),
            Surface::Cylinder {
                origin: [1.0, 1.0, 1.0],
                axis: [0.0, 0.0, 1.0],
                radius: 6.0
            }
        );
        let block = crate::build::box_mesh([0.0; 3], [1.0; 3]);
        assert_eq!(
            crate::faces::check::faces_agree(&transformed(&block, &stretch)),
            6
        );
    }

    #[test]
    fn invert_round_trip() {
        let m = mul(
            &rotation_about([3.0, -2.0, 1.0], [0.0, 0.6, 0.8], 0.7),
            &translation([5.0, 6.0, 7.0]),
        );
        let i = invert(&m).unwrap();
        let p = [1.5, -4.0, 9.0];
        let q = apply(&i, apply(&m, p));
        assert!(vec3::len(vec3::sub(p, q)) < 1e-12);
        let r = rotation_about([0.0; 3], [0.0, 0.0, 1.0], std::f64::consts::FRAC_PI_2);
        let q = apply(&r, [1.0, 0.0, 0.0]);
        assert!(vec3::len(vec3::sub(q, [0.0, 1.0, 0.0])) < 1e-12);
    }
}
