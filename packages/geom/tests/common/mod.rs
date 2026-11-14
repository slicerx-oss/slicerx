// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the exact tests share. Each test file uses some of them.

use serde_json::Value;
use std::f64::consts::TAU;
use sx_brep::Tessellation;
use sx_geom::fm::Fm;
use sx_geom::mesh::TriMesh;
use sx_geom::sketch_loft::{self, Density, Options, Profile, exact};
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

/// Points along a profile's true curves where it lies, `count` to a piece: each line, each arc as the circle through
/// its start, its point and its end taken the way through its point (or, given by its radius, the short way round to
/// its left), and a whole circle.
#[allow(clippy::cast_precision_loss, reason = "a point count")]
pub fn true_points(profile: &Value, count: usize) -> Vec<V3> {
    let v3 = |x: &Value| -> V3 { [0, 1, 2].map(|k| x[k].as_f64().unwrap()) };
    let v2 = |x: &Value| -> [f64; 2] { [x[0].as_f64().unwrap(), x[1].as_f64().unwrap()] };
    let frame = &profile["frame"];
    let (origin, across, up) = (v3(&frame["origin"]), v3(&frame["u"]), v3(&frame["v"]));
    let at = |p: [f64; 2]| {
        vec3::add(
            origin,
            vec3::add(vec3::scale(across, p[0]), vec3::scale(up, p[1])),
        )
    };
    let share = |step: usize| step as f64 / count as f64;
    let drawn = &profile["loops"][0];
    let mut out = Vec::new();
    let round = |out: &mut Vec<V3>, center: [f64; 2], radius: f64, start: f64, sweep: f64, ends: bool| {
        let last = if ends { count + 1 } else { count };
        out.extend((0..last).map(|step| {
            let (sin, cos) = (start + sweep * share(step)).m_sin_cos();
            at([center[0] + radius * cos, center[1] + radius * sin])
        }));
    };
    if drawn["type"] == "circle" {
        let radius = drawn["diameterMm"].as_f64().unwrap() / 2.0;
        round(&mut out, v2(&drawn["center"]), radius, 0.0, TAU, false);
        return out;
    }
    let line = |out: &mut Vec<V3>, from: [f64; 2], to: [f64; 2]| {
        out.extend((0..=count).map(|step| {
            at([
                from[0] + (to[0] - from[0]) * share(step),
                from[1] + (to[1] - from[1]) * share(step),
            ])
        }));
    };
    if let Some(points) = drawn["points"].as_array() {
        let ring: Vec<[f64; 2]> = points.iter().map(v2).collect();
        for (i, &from) in ring.iter().enumerate() {
            line(&mut out, from, ring[(i + 1) % ring.len()]);
        }
        return out;
    }
    let mut from = v2(&drawn["start"]);
    for segment in drawn["segments"].as_array().unwrap() {
        let to = v2(&segment["to"]);
        if segment["type"] == "arc" {
            let center = if let Some(radius) = segment["radiusMm"].as_f64() {
                // the center to the left of the chord, as the sketch puts a short arc that turns left
                let chord = [to[0] - from[0], to[1] - from[1]];
                let half = chord[0].m_hypot(chord[1]) / 2.0;
                let rise = (radius * radius - half * half).max(0.0).sqrt() / (2.0 * half);
                let mid = [f64::midpoint(from[0], to[0]), f64::midpoint(from[1], to[1])];
                [mid[0] - rise * chord[1], mid[1] + rise * chord[0]]
            } else {
                // the circle through the start, the arc's point and its end
                let through = v2(&segment["through"]);
                let [one, two, three] = [from, through, to].map(|p| p[0] * p[0] + p[1] * p[1]);
                let det = 2.0
                    * (from[0] * (through[1] - to[1])
                        + through[0] * (to[1] - from[1])
                        + to[0] * (from[1] - through[1]));
                [
                    (one * (through[1] - to[1]) + two * (to[1] - from[1]) + three * (from[1] - through[1]))
                        / det,
                    (one * (to[0] - through[0]) + two * (from[0] - to[0]) + three * (through[0] - from[0]))
                        / det,
                ]
            };
            let angle = |p: [f64; 2]| (p[1] - center[1]).m_atan2(p[0] - center[0]);
            let turn = (angle(to) - angle(from)).rem_euclid(TAU);
            // an arc by its radius turns counterclockwise; one through a point turns the way that point lies
            let ccw = segment.get("through").is_none_or(|through| {
                let through = v2(through);
                (through[0] - from[0]) * (to[1] - from[1]) - (through[1] - from[1]) * (to[0] - from[0]) > 0.0
            });
            let radius = (from[0] - center[0]).m_hypot(from[1] - center[1]);
            round(
                &mut out,
                center,
                radius,
                angle(from),
                if ccw { turn } else { turn - TAU },
                true,
            );
        } else {
            line(&mut out, from, to);
        }
        from = to;
    }
    out
}

/// A loft request's profiles and options, as the loft reads them.
pub fn parsed_loft(request: &Value) -> (Vec<Profile>, Options) {
    let opts = serde_json::json!({ "smooth": request["smooth"].as_bool().unwrap_or(false) });
    (
        serde_json::from_value(request["profiles"].clone()).unwrap(),
        serde_json::from_value(opts).unwrap(),
    )
}

/// An exact loft as it was held to its drawing: the loft, its fine mesh, each profile's true curves' farthest from the
/// body, its volume and the mesh loft's.
pub struct Held {
    pub lofted: exact::Lofted,
    pub mesh: sx_brep::Mesh,
    pub off: Vec<f64>,
    pub volume: f64,
    pub want: f64,
}

/// Lofts `request` exact, or fails naming `name`, and holds it to its drawn curves: every profile's true curves
/// within 0.01 mm of the body, and the body closed. Its volume and the mesh loft's are read, not compared.
pub fn held_to_its_curves(name: &str, request: &Value) -> Held {
    let (profiles, opts) = parsed_loft(request);
    let lofted = exact::lofted_through(&profiles, &opts, &Density::default(), exact::MOST_DOUBLINGS)
        .unwrap_or_else(|e| panic!("{name}: {e}"));
    assert!(
        lofted.drawn_mm <= sx_brep::DRAWN_MM,
        "{name}: {} mm",
        lofted.drawn_mm
    );
    // the kernel's own triangles, fine enough to measure to a hundredth of a millimeter
    let mesh = lofted
        .body
        .tessellate_as_made(&Tessellation {
            chord_mm: 1e-4,
            max_edge_mm: 0.25,
            ..Tessellation::default()
        })
        .expect("a fine mesh");
    let mut off = Vec::new();
    for (k, p) in request["profiles"].as_array().unwrap().iter().enumerate() {
        let far = farthest_from(&true_points(p, 512), &mesh.positions, &mesh.triangles, 0.5);
        assert!(
            far <= sx_brep::DRAWN_MM,
            "{name}: profile {} is {far} mm off the body",
            k + 1
        );
        off.push(far);
    }
    // two faces that share an edge share its points in the kernel's mesh, so a closed body has no open edge
    let report = TriMesh::new(mesh.positions.clone(), mesh.triangles.clone()).edge_report();
    assert!(
        report.is_watertight(),
        "{name}: the body is not closed, {report:?}"
    );
    let volume = lofted.body.volume().expect("volume");
    let flat = sketch_loft::loft_with(&profiles, &opts).unwrap();
    let want: f64 = flat
        .triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|v| flat.positions[v as usize]);
            vec3::dot(a, vec3::cross(b, c)) / 6.0
        })
        .sum();
    Held {
        lofted,
        mesh,
        off,
        volume,
        want,
    }
}

/// Lofts `request` exact and holds it to its drawing: [`held_to_its_curves`], and the volume within 0.2 percent of
/// the mesh loft's, whose arcs are chords inside the true ones.
pub fn held_to_its_drawing(name: &str, request: &Value) -> Held {
    let held = held_to_its_curves(name, request);
    let (volume, want) = (held.volume, held.want);
    assert!(
        ((volume - want) / want).abs() < 0.002,
        "{name}: volume {volume} against {want}"
    );
    held
}
