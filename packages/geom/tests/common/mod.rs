// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the exact tests share. Each test file uses some of them.

use serde_json::Value;
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

/// The SHA-256 of `bytes`, as lowercase hex: replies too large to keep are held to the bytes the code made before by
/// it.
pub fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    Sha256::digest(bytes).iter().fold(String::new(), |mut hex, b| {
        let _ = write!(hex, "{b:02x}");
        hex
    })
}

/// The farthest any of `points` is from the triangles `triangles` over `positions`. The triangles are filed in a
/// grid of `cell` mm, and the cells are searched outward from each point until no unsearched cell could hold a
/// nearer triangle.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "grid cells of a body a few hundred mm across"
)]
pub fn farthest_from(points: &[V3], positions: &[V3], triangles: &[[u32; 3]], cell: f64) -> f64 {
    use std::collections::HashMap;
    let key = |p: V3| p.map(|c| (c / cell).floor() as i64);
    let mut grid: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
    for (i, t) in triangles.iter().enumerate() {
        let corners = t.map(|v| positions[v as usize]);
        let (lo, hi) = (
            key([0, 1, 2].map(|a| corners.iter().map(|c| c[a]).fold(f64::INFINITY, f64::min))),
            key([0, 1, 2].map(|a| corners.iter().map(|c| c[a]).fold(f64::NEG_INFINITY, f64::max))),
        );
        for x in lo[0]..=hi[0] {
            for y in lo[1]..=hi[1] {
                for z in lo[2]..=hi[2] {
                    grid.entry([x, y, z]).or_default().push(i);
                }
            }
        }
    }
    let near = |p: V3| -> f64 {
        let at = key(p);
        let mut best = f64::INFINITY;
        for r in 0_i64..1000 {
            for x in -r..=r {
                for y in -r..=r {
                    for z in -r..=r {
                        if x.abs().max(y.abs()).max(z.abs()) != r {
                            continue;
                        }
                        for &i in grid.get(&[at[0] + x, at[1] + y, at[2] + z]).into_iter().flatten() {
                            let [a, b, c] = triangles[i].map(|v| positions[v as usize]);
                            let q = sx_geom::hollow::closest_point_on_triangle(p, a, b, c);
                            best = best.min(vec3::len(vec3::sub(q, p)));
                        }
                    }
                }
            }
            // any triangle not yet searched is more than r cells away
            if best <= r as f64 * cell {
                break;
            }
        }
        best
    };
    points.iter().map(|&p| near(p)).fold(0.0, f64::max)
}

/// Whether the mesh loft is the reference an exact loft of `profiles` is held to. The mesh loft flattens every
/// section into a ring of points and joins the rings point for point by count. Where a section is straight lines
/// alone, or one whole circle or ellipse, that keeps each corner on the corners of the sections beside it (or there
/// is no corner), so its sides are the loft's own. Where a section mixes corners with curves, the curves flatten to
/// different counts on different sections and the mesh loft joins a corner of one section to a point along the curve
/// of the next, so its side leans off the corners between sections. There the exact loft is held to the drawing: the
/// sections as drawn at their stations, and its corner rails, which join the drawn corners as the loft defines them.
pub fn mesh_loft_keeps_corners(profiles: &Value) -> bool {
    profiles.as_array().unwrap().iter().all(|p| {
        p["loops"].as_array().unwrap().iter().all(|lp| {
            let kind = lp["type"].as_str().unwrap_or("path");
            let segments = lp["segments"].as_array().map_or(&[][..], Vec::as_slice);
            matches!(kind, "circle" | "ellipse") || segments.iter().all(|s| s["type"] == "line")
        })
    })
}

/// A `width` by `height` rectangle about the origin with its corners rounded at `radius`: four lines and four arcs.
pub fn rounded(width: f64, height: f64, radius: f64) -> Value {
    let (half_w, half_h) = (width / 2.0, height / 2.0);
    let arc = |to: [f64; 2]| serde_json::json!({ "type": "arc", "to": to, "radiusMm": radius });
    let line = |to: [f64; 2]| serde_json::json!({ "type": "line", "to": to });
    serde_json::json!({
        "start": [-half_w + radius, -half_h],
        "segments": [
            line([half_w - radius, -half_h]), arc([half_w, -half_h + radius]),
            line([half_w, half_h - radius]), arc([half_w - radius, half_h]),
            line([-half_w + radius, half_h]), arc([-half_w, half_h - radius]),
            line([-half_w, -half_h + radius]), arc([-half_w + radius, -half_h]),
        ],
    })
}
