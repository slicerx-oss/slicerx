// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a solid lofted through closed sketch profiles, each on its own plane
// ring and vertex indices are taken modulo the ring length or come from the rings built here
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::face::FaceFrame;
use crate::faces::{Faces, Surface};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d::{self, Polygon};
use crate::sketch::{self, Loop};
use crate::vec3::{self, Frame, V2, V3};
use serde::Deserialize;

/// The most profiles one loft takes.
pub const MAX_PROFILES: usize = 64;
/// The most points one profile's ring may have once its arcs are flattened.
const MAX_RING: usize = 4096;

/// One section of a loft: closed sketch loops on a plane (the bed when `frame` is absent).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(default)]
    pub frame: Option<FaceFrame>,
    pub loops: Vec<Loop>,
}

/// A ring in 3D with the plane it lies on.
struct Section {
    ring: Vec<V3>,
    /// The ring's points in its own plane, in the same order.
    flat: Vec<V2>,
    frame: Frame,
    center: V3,
}

/// The solid through `profiles` in order: ruled sides from each profile to the next and flat caps on the first and
/// last. Each profile is one closed loop without holes. The rings are matched point to point with each ring's own
/// corners kept, turned to wind the same way along the loft and rotated to the least twist.
pub fn loft(profiles: &[Profile]) -> Result<TriMesh> {
    if profiles.len() < 2 {
        return Err(Error::invalid("profiles", "a loft needs 2 or more profiles"));
    }
    if profiles.len() > MAX_PROFILES {
        return Err(Error::invalid(
            "profiles",
            format!("a loft takes at most {MAX_PROFILES} profiles"),
        ));
    }
    let mut rings = Vec::with_capacity(profiles.len());
    for (k, p) in profiles.iter().enumerate() {
        rings.push((frame_of(p)?, ring_of(k, &p.loops)?));
    }
    let n = rings.iter().map(|(_, r)| r.len()).max().unwrap_or(0);
    let mut sections: Vec<Section> = rings
        .iter()
        .map(|(frame, ring)| {
            let flat = resample(ring, n);
            let ring: Vec<V3> = flat.iter().map(|&p| frame.at(p, 0.0)).collect();
            let center = centroid(&ring);
            Section {
                ring,
                flat,
                frame: *frame,
                center,
            }
        })
        .collect();
    let size = sections
        .iter()
        .flat_map(|s| s.ring.iter())
        .fold(0.0f64, |m, p| m.max(p[0].abs()).max(p[1].abs()).max(p[2].abs()))
        .max(1.0);
    let eps = size * 1e-9;
    // Every ring winds counterclockwise about the way the loft goes from it.
    let count = sections.len();
    for k in 0..count {
        let along = if k + 1 < count {
            vec3::sub(sections[k + 1].center, sections[k].center)
        } else {
            vec3::sub(sections[k].center, sections[k - 1].center)
        };
        if vec3::dot(sections[k].frame.w, along) < 0.0 {
            sections[k].ring.reverse();
            sections[k].flat.reverse();
        }
    }
    for k in 0..count - 1 {
        apart(&sections[k], &sections[k + 1], k, eps)?;
    }
    for k in 1..count {
        let shift = least_twist(&sections[k - 1], &sections[k]);
        sections[k].ring.rotate_left(shift);
        sections[k].flat.rotate_left(shift);
    }
    build(&sections, size)
}

fn frame_of(p: &Profile) -> Result<Frame> {
    p.frame.unwrap_or_else(|| FaceFrame::bed([0.0, 0.0])).checked()
}

/// The profile's one closed ring, counterclockwise in its plane.
fn ring_of(k: usize, loops: &[Loop]) -> Result<Vec<V2>> {
    let no = k + 1;
    let c = sketch::check(loops);
    if let Some(i) = c.issues.into_iter().next() {
        return Err(Error::invalid("profiles", format!("profile {no}: {}", i.message)));
    }
    let mut polys: Vec<Polygon> = c.polygons;
    let Some(mut poly) = polys.pop() else {
        return Err(Error::invalid(
            "profiles",
            format!("profile {no}: nothing to loft"),
        ));
    };
    if !polys.is_empty() {
        return Err(Error::invalid(
            "profiles",
            format!(
                "profile {no}: a loft profile is one closed loop, not {}",
                polys.len() + 1
            ),
        ));
    }
    if !poly.holes.is_empty() {
        return Err(Error::invalid(
            "profiles",
            format!("profile {no}: a loft profile has no holes yet"),
        ));
    }
    poly.normalize_orientation();
    if poly.outer.len() > MAX_RING {
        return Err(Error::invalid(
            "profiles",
            format!("profile {no}: more than {MAX_RING} points once its arcs are flattened"),
        ));
    }
    Ok(poly.outer)
}

/// `ring` with `n` points: its own points all kept, and the points it lacks spread over its sides by their length.
fn resample(ring: &[V2], n: usize) -> Vec<V2> {
    let k = ring.len();
    if n <= k {
        return ring.to_vec();
    }
    let lens: Vec<f64> = (0..k)
        .map(|i| {
            let (a, b) = (ring[i], ring[(i + 1) % k]);
            (b[0] - a[0]).m_hypot(b[1] - a[1])
        })
        .collect();
    let total: f64 = lens.iter().sum();
    let extra = n - k;
    // the largest remainder way: each side its whole share, then one more to the sides with the largest remainders
    let shares: Vec<f64> = lens.iter().map(|l| l / total * extra as f64).collect();
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a share is between 0 and the extra count"
    )]
    let mut counts: Vec<usize> = shares.iter().map(|s| s.floor() as usize).collect();
    let mut left = extra - counts.iter().sum::<usize>();
    let mut order: Vec<usize> = (0..k).collect();
    order.sort_by(|&a, &b| {
        let (ra, rb) = (shares[a] - shares[a].floor(), shares[b] - shares[b].floor());
        rb.total_cmp(&ra).then(a.cmp(&b))
    });
    for &i in &order {
        if left == 0 {
            break;
        }
        counts[i] += 1;
        left -= 1;
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..k {
        let (a, b) = (ring[i], ring[(i + 1) % k]);
        out.push(a);
        let m = counts[i];
        for j in 1..=m {
            let t = j as f64 / (m + 1) as f64;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    }
    out
}

fn centroid(ring: &[V3]) -> V3 {
    let s = ring.iter().fold([0.0; 3], |acc, &p| vec3::add(acc, p));
    vec3::scale(s, 1.0 / ring.len().max(1) as f64)
}

/// The normal a ring winds counterclockwise about: its plane's, turned the way the ring goes round.
fn winding_normal(s: &Section) -> V3 {
    let flat_ccw = poly2d::signed_area(&s.flat) >= 0.0;
    if flat_ccw {
        s.frame.w
    } else {
        vec3::scale(s.frame.w, -1.0)
    }
}

/// Fails when neighboring profiles `k` and `k + 1` (from 0) touch or cross: each must lie wholly ahead of the other's
/// plane along the loft.
fn apart(a: &Section, b: &Section, k: usize, eps: f64) -> Result<()> {
    let (na, nb) = (winding_normal(a), winding_normal(b));
    let ahead = b
        .ring
        .iter()
        .map(|&p| vec3::dot(na, vec3::sub(p, a.frame.origin)))
        .fold(f64::INFINITY, f64::min);
    let behind = a
        .ring
        .iter()
        .map(|&p| vec3::dot(nb, vec3::sub(p, b.frame.origin)))
        .fold(f64::NEG_INFINITY, f64::max);
    if ahead > eps && behind < -eps {
        Ok(())
    } else {
        Err(Error::geometry(
            "loft",
            format!(
                "profiles {} and {} touch or cross; space them apart along the loft",
                k + 1,
                k + 2
            ),
        ))
    }
}

/// The start of `b` that lines it up with `a` with the least twist: the rotation with the least summed squared
/// distance between matched points, each ring taken about its own center.
fn least_twist(a: &Section, b: &Section) -> usize {
    let n = a.ring.len();
    let pa: Vec<V3> = a.ring.iter().map(|&p| vec3::sub(p, a.center)).collect();
    let pb: Vec<V3> = b.ring.iter().map(|&p| vec3::sub(p, b.center)).collect();
    let mut best = (f64::INFINITY, 0);
    for s in 0..n {
        let d: f64 = (0..n)
            .map(|i| {
                let e = vec3::sub(pa[i], pb[(i + s) % n]);
                vec3::dot(e, e)
            })
            .sum();
        if d < best.0 {
            best = (d, s);
        }
    }
    best.1
}

/// The mesh: one vertex per ring point, two triangles per quad of sides, the caps clipped in their planes. A side
/// quad that is flat is a plane face; each span's other sides are one face with no known surface.
#[allow(
    clippy::cast_possible_truncation,
    reason = "ring and profile counts are capped far below 2^32"
)]
fn build(sections: &[Section], size: f64) -> Result<TriMesh> {
    let n = sections[0].ring.len();
    let mut m = TriMesh::default();
    let mut faces = Faces::default();
    for s in sections {
        m.positions.extend_from_slice(&s.ring);
    }
    let at = |k: usize, i: usize| (k * n + i % n) as u32;
    let flat_tol = size * 1e-9;
    for k in 0..sections.len() - 1 {
        let mut other: Option<u32> = None;
        for i in 0..n {
            let (a0, a1, b0, b1) = (at(k, i), at(k, i + 1), at(k + 1, i), at(k + 1, i + 1));
            let quad = [a0, a1, b1, b0].map(|v| m.positions[v as usize]);
            let id = match quad_plane(quad, flat_tol) {
                Some(s) => faces.push(s),
                None => *other.get_or_insert_with(|| faces.push(Surface::Other)),
            };
            m.triangles.push([a0, a1, b1]);
            m.triangles.push([a0, b1, b0]);
            faces.ids.extend([id, id]);
        }
    }
    let last = sections.len() - 1;
    for (k, outward) in [(0, -1.0), (last, 1.0)] {
        let s = &sections[k];
        let poly = Polygon {
            outer: s.flat.clone(),
            holes: Vec::new(),
        };
        let tris = poly2d::triangulate(&poly)?;
        let normal = vec3::scale(winding_normal(s), outward);
        let id = faces.push(Surface::Plane {
            normal,
            offset: vec3::dot(normal, s.ring[0]),
        });
        // ear clipping turns every triangle counterclockwise in the plane, so they all face the plane's normal
        let along = vec3::dot(s.frame.w, normal) >= 0.0;
        for t in tris {
            let (a, b, c) = (at(k, t[0] as usize), at(k, t[1] as usize), at(k, t[2] as usize));
            m.triangles.push(if along { [a, b, c] } else { [a, c, b] });
            faces.ids.push(id);
        }
    }
    m.faces = Some(crate::faces::merge_meeting_planes(&m, faces));
    Ok(m)
}

/// The plane of a side quad (outward, the way its corners go round) when all four corners lie on it.
fn quad_plane(q: [V3; 4], tol: f64) -> Option<Surface> {
    let normal = vec3::normalize(vec3::cross(vec3::sub(q[2], q[0]), vec3::sub(q[3], q[1])))?;
    let offset = vec3::dot(normal, q[0]);
    q.iter()
        .all(|&p| (vec3::dot(normal, p) - offset).abs() <= tol.max(1e-9))
        .then_some(Surface::Plane { normal, offset })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(c: V2, s: f64) -> Loop {
        let h = s / 2.0;
        Loop {
            points: vec![
                [c[0] - h, c[1] - h],
                [c[0] + h, c[1] - h],
                [c[0] + h, c[1] + h],
                [c[0] - h, c[1] + h],
            ],
            ..Loop::default()
        }
    }

    fn circle(c: V2, d: f64) -> Loop {
        Loop {
            kind: Some("circle".into()),
            center: Some(c),
            diameter_mm: Some(d),
            ..Loop::default()
        }
    }

    fn at(z: f64, l: Loop) -> Profile {
        let mut frame = FaceFrame::bed([0.0, 0.0]);
        frame.origin[2] = z;
        Profile {
            frame: Some(frame),
            loops: vec![l],
        }
    }

    fn closed(m: &TriMesh) {
        let e = m.edge_report();
        assert!(e.is_watertight(), "{e:?}");
        assert_eq!(m.components().len(), 1);
    }

    #[test]
    fn square_to_smaller_square_is_a_frustum() {
        let m = loft(&[
            at(0.0, square([0.0, 0.0], 20.0)),
            at(10.0, square([0.0, 0.0], 10.0)),
        ])
        .unwrap();
        closed(&m);
        let (a1, a2, h) = (400.0f64, 100.0f64, 10.0);
        let v = h / 3.0 * (a1 + a2 + (a1 * a2).sqrt());
        assert!((m.volume() - v).abs() < 1e-6, "{} vs {v}", m.volume());
        // four flat sides, a top and a bottom
        let f = m.faces.as_ref().unwrap();
        assert!(
            f.table.iter().all(|s| matches!(s, Surface::Plane { .. })),
            "{:?}",
            f.table
        );
    }

    #[test]
    fn square_to_circle_is_closed_and_between_the_two() {
        let m = loft(&[
            at(0.0, square([0.0, 0.0], 20.0)),
            at(30.0, circle([0.0, 0.0], 10.0)),
        ])
        .unwrap();
        closed(&m);
        let v = m.volume();
        let (lo, hi) = (30.0 * 78.5, 30.0 * 400.0);
        assert!(v > lo && v < hi, "{v}");
        let b = m.bounds().unwrap();
        assert!((b.max[2] - 30.0).abs() < 1e-9 && b.min[2].abs() < 1e-9);
    }

    #[test]
    fn three_profiles_with_a_clockwise_square_in_the_middle() {
        let mut back = square([0.0, 0.0], 12.0);
        back.points.reverse();
        let m = loft(&[
            at(0.0, circle([0.0, 0.0], 20.0)),
            at(10.0, back),
            at(25.0, circle([2.0, 0.0], 16.0)),
        ])
        .unwrap();
        closed(&m);
        assert!(m.volume() > 0.0);
    }

    #[test]
    fn a_tilted_profile_lofts() {
        let tilted = Profile {
            frame: Some(FaceFrame::for_normal([0.0, 0.0, 20.0], [0.3, 0.0, 1.0]).unwrap()),
            loops: vec![circle([0.0, 0.0], 12.0)],
        };
        let m = loft(&[at(0.0, square([0.0, 0.0], 16.0)), tilted]).unwrap();
        closed(&m);
        assert!(m.volume() > 0.0);
    }

    #[test]
    fn a_profile_upside_down_lofts_the_same() {
        let down = Profile {
            frame: Some(FaceFrame::for_normal([0.0, 0.0, 10.0], [0.0, 0.0, -1.0]).unwrap()),
            loops: vec![square([0.0, 0.0], 10.0)],
        };
        let m = loft(&[at(0.0, square([0.0, 0.0], 20.0)), down]).unwrap();
        closed(&m);
        let v = 10.0 / 3.0 * (400.0 + 100.0 + 200.0);
        assert!((m.volume() - v).abs() < 1e-6, "{}", m.volume());
    }

    #[test]
    fn says_what_is_wrong() {
        let err = |p: &[Profile]| loft(p).unwrap_err().to_string();
        assert!(err(&[at(0.0, square([0.0, 0.0], 10.0))]).contains("2 or more profiles"));
        let two = Profile {
            frame: None,
            loops: vec![square([0.0, 0.0], 10.0), square([30.0, 0.0], 10.0)],
        };
        assert!(
            err(&[two, at(5.0, square([0.0, 0.0], 5.0))])
                .contains("profile 1: a loft profile is one closed loop, not 2")
        );
        let holed = Profile {
            frame: None,
            loops: vec![square([0.0, 0.0], 10.0), square([0.0, 0.0], 4.0)],
        };
        assert!(
            err(&[at(-5.0, square([0.0, 0.0], 5.0)), holed])
                .contains("profile 2: a loft profile has no holes yet")
        );
        let open = Loop {
            start: Some([0.0, 0.0]),
            segments: vec![sketch::Segment {
                kind: "line".into(),
                to: Some([10.0, 0.0]),
                ..sketch::Segment::default()
            }],
            ..Loop::default()
        };
        assert!(err(&[at(0.0, square([0.0, 0.0], 5.0)), at(5.0, open)]).starts_with("profiles: profile 2: "));
        assert!(
            err(&[
                at(0.0, square([0.0, 0.0], 10.0)),
                at(0.0, circle([0.0, 0.0], 4.0))
            ])
            .contains("profiles 1 and 2 touch or cross")
        );
        // the middle profile tips across the first one's plane
        let tipped = Profile {
            frame: Some(FaceFrame::for_normal([0.0, 0.0, 2.0], [1.0, 0.0, 0.2]).unwrap()),
            loops: vec![square([0.0, 0.0], 30.0)],
        };
        assert!(
            err(&[
                at(0.0, square([0.0, 0.0], 10.0)),
                tipped,
                at(20.0, square([0.0, 0.0], 10.0))
            ])
            .contains("profiles 1 and 2 touch or cross")
        );
    }

    #[test]
    fn keeps_every_corner_when_it_adds_points() {
        let r = resample(&[[0.0, 0.0], [10.0, 0.0], [10.0, 1.0], [0.0, 1.0]], 26);
        assert_eq!(r.len(), 26);
        for c in [[0.0, 0.0], [10.0, 0.0], [10.0, 1.0], [0.0, 1.0]] {
            assert!(r.contains(&c), "{c:?}");
        }
        // the long sides get ten more points each, the short ones one
        assert_eq!(r.iter().filter(|p| p[1] == 0.0).count(), 12);
    }
}
