// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! corner normals packed the way meshes carry them outside the engine: two i16 per corner, six per triangle
//!
//! the same map as packages/contracts/src/normals.ts, number for number. the normal is scaled so |x| + |y| + |z|
//! is 1 and the lower half (z below 0) folds outward; fixtures/mesh-normal-pack.json there holds the vectors both
//! are tested against.

/// What both numbers of a corner hold when it has no normal.
pub const NO_NORMAL: i16 = -32768;

fn sign(v: f64) -> f64 {
    if v < 0.0 { -1.0 } else { 1.0 }
}

#[allow(clippy::cast_possible_truncation, reason = "clamped to -32767..32767 first")]
fn stored(v: f64) -> i16 {
    (v * 32767.0 + 0.5).floor().clamp(-32767.0, 32767.0) as i16
}

/// The pair for a normal of any length. The zero vector, or one that is not a number, packs as no normal.
#[must_use]
pub fn pack([x, y, z]: [f64; 3]) -> [i16; 2] {
    let l = x.abs() + y.abs() + z.abs();
    if !(l.is_finite() && l > 0.0) {
        return [NO_NORMAL; 2];
    }
    let (px, py) = (x / l, y / l);
    if z >= 0.0 {
        [stored(px), stored(py)]
    } else {
        [
            stored((1.0 - py.abs()) * sign(px)),
            stored((1.0 - px.abs()) * sign(py)),
        ]
    }
}

/// The unit normal a pair holds, or none for the pair that says so.
#[must_use]
pub fn unpack([a, b]: [i16; 2]) -> Option<[f64; 3]> {
    if a == NO_NORMAL && b == NO_NORMAL {
        return None;
    }
    let (mut x, mut y) = (f64::from(a) / 32767.0, f64::from(b) / 32767.0);
    let z = 1.0 - x.abs() - y.abs();
    if z < 0.0 {
        (x, y) = ((1.0 - y.abs()) * sign(x), (1.0 - x.abs()) * sign(y));
    }
    let l = (x * x + y * y + z * z).sqrt();
    Some([x / l, y / l, z / l])
}

/// Six numbers per triangle from its three corner normals. A triangle without them, or with a corner that packs
/// as none, is six times [`NO_NORMAL`]: a triangle has exact normals at all three corners or at none.
#[must_use]
pub fn pack_triangles(normals: &[Option<[[f64; 3]; 3]>]) -> Vec<i16> {
    let mut out = Vec::with_capacity(6 * normals.len());
    for corners in normals {
        let packed = corners.map(|c| c.map(pack));
        match packed {
            Some(p) if p.iter().all(|&c| c != [NO_NORMAL; 2]) => out.extend(p.iter().flatten()),
            _ => out.extend([NO_NORMAL; 6]),
        }
    }
    out
}

/// Whether triangle `t` of a packed buffer has a normal at all three corners.
#[must_use]
pub fn exact_triangle(packed: &[i16], t: usize) -> bool {
    packed
        .as_chunks::<6>()
        .0
        .get(t)
        .is_some_and(|six| six.as_chunks::<2>().0.iter().all(|c| *c != [NO_NORMAL; 2]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fm::Fm;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../contracts/fixtures/mesh-normal-pack.json")).unwrap()
    }

    fn pair(v: &Value) -> [i16; 2] {
        [0, 1].map(|k| i16::try_from(v[k].as_i64().unwrap()).unwrap())
    }

    fn angle_deg(a: [f64; 3], b: [f64; 3]) -> f64 {
        let c = crate::vec3::cross(a, b);
        crate::vec3::len(c).m_atan2(crate::vec3::dot(a, b)).to_degrees()
    }

    #[test]
    fn every_shared_vector_packs_to_its_pair_and_comes_back_within_the_angle() {
        let f = fixture();
        let max = f["maxAngleDeg"].as_f64().unwrap();
        let cases = f["cases"].as_array().unwrap();
        assert!(cases.len() >= 28);
        for case in cases {
            let name = &case["name"];
            let normal = [0, 1, 2].map(|k| case["normal"][k].as_f64().unwrap());
            let packed = pair(&case["packed"]);
            assert_eq!(pack(normal), packed, "{name}: packed");
            if packed == [NO_NORMAL; 2] {
                assert_eq!(unpack(packed), None, "{name}");
                continue;
            }
            let back = unpack(packed).unwrap();
            assert!((crate::vec3::len(back) - 1.0).abs() < 1e-12, "{name}: unit");
            let off = angle_deg(back, normal);
            assert!(off <= max, "{name}: {off} degrees off");
            assert_eq!(pack(back), packed, "{name}: packed again");
        }
    }

    #[test]
    fn a_normal_of_any_length_packs_as_its_direction() {
        assert_eq!(pack([0.0, 0.0, 5.0]), [0, 0]);
        assert_eq!(pack([0.0, 0.0, -1e-9]), [32767, 32767]);
        assert_eq!(pack([3.6, 4.8, -8.0]), pack([0.36, 0.48, -0.8]));
        // minus zero is not below zero: the upper half, and a sign of 1 in the fold
        assert_eq!(pack([1.0, 0.0, -0.0]), [32767, 0]);
        assert_eq!(pack([-0.0, 0.0, -1.0]), [32767, 32767]);
    }

    #[test]
    fn what_is_not_a_direction_packs_as_no_normal() {
        for bad in [
            [0.0; 3],
            [f64::NAN, 0.0, 1.0],
            [0.0, f64::INFINITY, 0.0],
            [0.0, 0.0, f64::NEG_INFINITY],
        ] {
            assert_eq!(pack(bad), [NO_NORMAL; 2], "{bad:?}");
        }
        assert_eq!(unpack([NO_NORMAL; 2]), None);
        // one number alone at the lowest value is still a pair that holds a normal
        assert!(unpack([NO_NORMAL, 0]).is_some());
    }

    #[test]
    fn a_triangle_has_normals_at_all_three_corners_or_at_none() {
        let up = [0.0, 0.0, 1.0];
        let packed = pack_triangles(&[
            Some([up, [1.0, 0.0, 0.0], [0.0, -1.0, 0.0]]),
            None,
            Some([up, [0.0; 3], up]),
        ]);
        assert_eq!(packed.len(), 18);
        assert_eq!(packed[..6], [0, 0, 32767, 0, 0, -32767]);
        assert_eq!(packed[6..12], [NO_NORMAL; 6]);
        assert_eq!(packed[12..], [NO_NORMAL; 6]);
        assert!(exact_triangle(&packed, 0));
        assert!(!exact_triangle(&packed, 1));
        assert!(!exact_triangle(&packed, 2));
        assert!(!exact_triangle(&packed, 3));
    }
}
