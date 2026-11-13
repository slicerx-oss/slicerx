// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the exact tests share.

use sx_geom::vec3::{self, V3};

/// Whether a volume the kernel computed is `want` to a millionth of it. The kernel integrates a solid's volume
/// itself, and its last digits differ between compilers and machines, so a volume from the kernel is held to a share
/// of itself, never to a fixed number of mm3.
pub fn volume_near(volume: f64, want: f64) -> bool {
    (volume - want).abs() <= 1e-6 * want.abs()
}

/// How far a point of a flat triangle is from the triangle's face: the smaller of the face's own closest point
/// and, when that is past `chord`, a second measure. With `on`, that is how far the surface is at the same shares
/// of the corners' places on it, brought nearer in two steps inside the triangle; without it, for the middle of a
/// side on the face's outline, the nearest of `outline`, the body's edges around the face. All are distances to
/// real points of the face. The closest point alone reads a body thinner than the chord by its far side.
pub fn off_its_face(
    face: sx_brep::Face<'_>,
    sample: V3,
    chord: f64,
    on: Option<Surfaced>,
    outline: &[sx_brep::Edge<'_>],
) -> f64 {
    let solved = face.distance_to(sample).unwrap();
    if solved <= chord {
        return solved;
    }
    let Some((points, places, mut shares)) = on else {
        return outline
            .iter()
            .map(|edge| edge.distance_to(sample).unwrap())
            .fold(solved, f64::min);
    };
    // a place on the end of the surface's range is stored a hair past it: each is drawn a little inward
    let middle = [0, 1].map(|k| (places[0][k] + places[1][k] + places[2][k]) / 3.0);
    let places = places.map(|uv| [0, 1].map(|k| uv[k] + (middle[k] - uv[k]) * 1e-9));
    let (along, across) = (vec3::sub(points[1], points[0]), vec3::sub(points[2], points[0]));
    let (aa, ab, bb) = (
        vec3::dot(along, along),
        vec3::dot(along, across),
        vec3::dot(across, across),
    );
    let det = aa * bb - ab * ab;
    let mut least = solved;
    for _ in 0..3 {
        let uv = [0, 1].map(|k| {
            places[0][k]
                + shares[0] * (places[1][k] - places[0][k])
                + shares[1] * (places[2][k] - places[0][k])
        });
        let Ok(there) = face.point_at(uv) else { break };
        let off = vec3::sub(sample, there);
        least = least.min(vec3::len(off));
        if det <= 0.0 {
            break;
        }
        let (to_along, to_across) = (vec3::dot(off, along), vec3::dot(off, across));
        let moved = [
            (shares[0] + (to_along * bb - to_across * ab) / det).max(0.0),
            (shares[1] + (to_across * aa - to_along * ab) / det).max(0.0),
        ];
        let all = (moved[0] + moved[1]).max(1.0);
        shares = [moved[0] / all, moved[1] / all];
    }
    least
}

/// A place a triangle is measured at: its face, the point, and for a place the surface can be asked at, the
/// triangle's corners, their places on the surface and the shares of the second and third the point has.
pub type Sample = (u32, V3, Option<Surfaced>);

/// A triangle on its face's surface and a place in it: the corners, their places on the surface, and the shares of
/// the second and third corners the place has.
pub type Surfaced = ([V3; 3], [[f64; 2]; 3], [f64; 2]);

/// Where a mesh's triangles are measured against their faces: each one's middle and the middle of each of its
/// sides. A side on its face's outline has no place on the surface to be asked at, as the surface between its ends
/// can lie outside the outline.
pub fn sampled(mesh: &sx_brep::Mesh) -> Vec<Sample> {
    use std::collections::HashMap;
    let at = |v: u32| mesh.positions[v as usize];
    let mid = |points: &[V3]| -> V3 {
        #[allow(clippy::cast_precision_loss, reason = "two or three")]
        let n = points.len() as f64;
        [0, 1, 2].map(|k| points.iter().map(|p| p[k]).sum::<f64>() / n)
    };
    let side = |triangle: &[u32; 3], k: usize| {
        let (from, to) = (triangle[k], triangle[(k + 1) % 3]);
        (from.min(to), from.max(to))
    };
    // how many triangles of one face are on each side: two inside the face
    let mut inside: HashMap<((u32, u32), u32), usize> = HashMap::new();
    for (triangle, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        for k in 0..3 {
            *inside.entry((side(triangle, k), face)).or_default() += 1;
        }
    }
    let mut out = Vec::with_capacity(4 * mesh.triangles.len());
    for ((triangle, &face), places) in mesh.triangles.iter().zip(&mesh.faces).zip(&mesh.uvs) {
        let [pa, pb, pc] = triangle.map(at);
        let inner = |k: usize| inside.get(&(side(triangle, k), face)) == Some(&2);
        for (sample, shares) in [
            (mid(&[pa, pb, pc]), Some([1.0 / 3.0, 1.0 / 3.0])),
            (mid(&[pa, pb]), inner(0).then_some([0.5, 0.0])),
            (mid(&[pb, pc]), inner(1).then_some([0.5, 0.5])),
            (mid(&[pc, pa]), inner(2).then_some([0.0, 0.5])),
        ] {
            let on = places
                .zip(shares)
                .map(|(places, shares)| ([pa, pb, pc], places, shares));
            out.push((face, sample, on));
        }
    }
    out
}

/// The farthest a mesh's triangles are from their own faces of `body`: how far in mm, on which face and where.
/// Measured at every place [`sampled`] gives, by [`off_its_face`] with the edges around each face.
pub fn farthest_off_its_faces(body: &sx_brep::Body, mesh: &sx_brep::Mesh, chord: f64) -> (f64, u32, V3) {
    let faces = body.faces().unwrap();
    let edges = body.edges().unwrap();
    let around: Vec<Vec<sx_brep::Edge<'_>>> = faces
        .iter()
        .map(|face| {
            edges
                .iter()
                .filter(|edge| edge.faces().contains(face))
                .copied()
                .collect()
        })
        .collect();
    let mut worst = (0.0_f64, 0, [0.0; 3]);
    for (face, sample, on) in sampled(mesh) {
        let far = off_its_face(faces[face as usize], sample, chord, on, &around[face as usize]);
        if far.is_nan() || far > worst.0 {
            worst = (far, face, sample);
        }
    }
    worst
}
