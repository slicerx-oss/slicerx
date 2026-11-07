// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a solid swept from one sketch profile along an open path: a closed profile, or an open one thickened into a shell
// ring and path indices come from the rings and paths built here
#![allow(clippy::indexing_slicing)]

use crate::boolean;
use crate::error::{Error, Result};
use crate::face::FaceFrame;
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d;
use crate::sketch::{self, Loop};
use crate::sketch_loft::{self, Profile, Section};
use crate::thicken::{self, Thicken};
use crate::vec3::{self, Frame, V2, V3};
use serde::Deserialize;

/// The most points a path may have once its arcs are flattened.
pub const MAX_PATH: usize = 4096;
/// The most ring points one sweep makes (profile points times path points).
const MAX_POINTS: usize = 1_000_000;
/// The profile's plane must cross the path's start by more than this angle, in degrees.
const MIN_START_DEG: f64 = 1.0;
/// The shortest step between two path points, mm.
const MIN_STEP_MM: f64 = 1e-6;

/// The path of a sweep: one open chain of lines, arcs and splines drawn on a plane (the bed when `frame` is absent), or an
/// open polyline of points in space.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Path {
    pub frame: Option<FaceFrame>,
    pub loops: Vec<Loop>,
    pub points: Vec<V3>,
}

/// The solid swept from `profile` along `path`: the profile keeps its place and turn relative to the path (a rotation
/// minimizing frame, so it does not twist about the path), with ruled sides between path points and flat caps. At each
/// corner of the path the sides meet on the plane halfway between the two directions, so a path of straight lines
/// sweeps exact prisms and a flattened arc follows the arc. The profile does not need to touch the path; it is carried
/// as it sits relative to the path's start.
pub fn sweep(profile: &Profile, path: &Path) -> Result<TriMesh> {
    sweep_with(profile, path, None)
}

/// The sweep, with its sides made a shell `thicken` thick and no caps when that is given. An open profile makes a
/// surface, so it needs `thicken`.
#[allow(
    clippy::too_many_lines,
    reason = "one pass from the profile and path to the mesh"
)]
pub fn sweep_with(profile: &Profile, path: &Path, thicken: Option<&Thicken>) -> Result<TriMesh> {
    if profile.open && thicken.is_none() {
        return Err(Error::invalid(
            "thicken",
            "an open profile makes a surface; give thicken to make it a solid",
        ));
    }
    let (pts, t_start, t_end) = path_points(path)?;
    let frame = profile
        .frame
        .unwrap_or_else(|| FaceFrame::bed([0.0, 0.0]))
        .checked()?;
    let mut flat = if profile.open {
        let mut c =
            sketch_loft::open_ring(&profile.loops, "sweep").map_err(|why| Error::invalid("profile", why))?;
        // an open chain winds the way it and the line across its ends go around, as a closed ring does
        if poly2d::signed_area(&c) < 0.0 {
            c.reverse();
        }
        c
    } else {
        sketch_loft::one_ring(&profile.loops, "sweep").map_err(|why| Error::invalid("profile", why))?
    };
    if flat.len().saturating_mul(pts.len()) > MAX_POINTS {
        return Err(Error::invalid(
            "path",
            format!(
                "the sweep would have more than {MAX_POINTS} points; use a shorter path, fewer arcs or a simpler profile"
            ),
        ));
    }
    let m = pts.len();
    let tangents: Vec<V3> = (0..m - 1)
        .map(|k| vec3::normalize(vec3::sub(pts[k + 1], pts[k])).unwrap_or([0.0, 0.0, 1.0]))
        .collect();
    let facing = across(t_start, frame.w, 0.0)?;
    // the side lines leave along the first chord, which a flattened arc turns from its own start
    across(tangents[0], frame.w, facing)?;
    // every ring winds counterclockwise about the way the sweep goes
    if facing < 0.0 {
        flat.reverse();
    }
    let profile_pts: Vec<V3> = flat.iter().map(|&p| frame.at(p, 0.0)).collect();
    let size = profile_pts
        .iter()
        .chain(pts.iter())
        .fold(0.0f64, |s, p| s.max(p[0].abs()).max(p[1].abs()).max(p[2].abs()))
        .max(1.0);
    let eps = size * 1e-9;

    // Each profile point and the profile's axes, from the path's start, carried along the path. A flattened arc's first
    // chord leaves at half a chord's turn from the arc itself, so they turn by that first; the side lines then meet the
    // profile's plane in a copy of it stretched by at most the arc's own flattening tolerance.
    let lead = |v: V3| turned(v, t_start, tangents[0]);
    let mut offs: Vec<V3> = profile_pts.iter().map(|&p| lead(vec3::sub(p, pts[0]))).collect();
    let (mut fo, mut fu, mut fv, mut fw) = (
        lead(vec3::sub(frame.origin, pts[0])),
        lead(frame.u),
        lead(frame.v),
        lead(frame.w),
    );
    let mut rings: Vec<Vec<V3>> = Vec::with_capacity(m);
    rings.push(onto(&offs, pts[0], tangents[0], frame.origin, frame.w));
    for k in 1..m - 1 {
        let (t0, t1) = (tangents[k - 1], tangents[k]);
        // the miter plane between the two directions; `path_points` refused a path that doubles back
        let nm = vec3::normalize(vec3::add(t0, t1)).unwrap_or(t0);
        let den = vec3::dot(t0, nm);
        rings.push(
            offs.iter()
                .map(|&o| {
                    let t = -vec3::dot(o, nm) / den;
                    vec3::add(pts[k], vec3::add(o, vec3::scale(t0, t)))
                })
                .collect(),
        );
        let turn = |v: V3| turned(v, t0, t1);
        for o in &mut offs {
            *o = turn(*o);
        }
        (fo, fu, fv, fw) = (turn(fo), turn(fu), turn(fv), turn(fw));
    }
    // the end cap: the profile's plane carried to the end, turned to the way the path arrives there
    let last = tangents[m - 2];
    let tail = |v: V3| turned(v, last, t_end);
    let (fo, fu, fv, fw) = (tail(fo), tail(fu), tail(fv), tail(fw));
    let end_origin = vec3::add(pts[m - 1], fo);
    across(last, fw, facing)?;
    rings.push(onto(&offs, pts[m - 1], last, end_origin, fw));

    sides_forward(&rings, &pts, &tangents, eps)?;

    let end_frame = Frame {
        origin: end_origin,
        u: fu,
        v: fv,
        w: fw,
    };
    if let Some(t) = thicken {
        let spans: Vec<usize> = (0..rings.len()).collect();
        let surface = sketch_loft::build_rows(&rings, &spans, !profile.open, None, None, size)?;
        return thicken::thicken(&surface, t);
    }
    let count = rings.len();
    let sections: Vec<Section> = rings
        .into_iter()
        .enumerate()
        .map(|(k, ring)| Section {
            center: sketch_loft::centroid(&ring),
            ring,
            flat: flat.clone(),
            frame: if k + 1 == count { end_frame } else { frame },
        })
        .collect();
    let mesh = sketch_loft::build(&sections, size)?;
    if boolean::Solid::new(&mesh).is_ok_and(|s| s.self_intersects()) {
        return Err(Error::geometry(
            "sweep",
            "the swept body runs into itself where the path comes back near itself; move those parts of the path further apart or use a smaller profile",
        ));
    }
    Ok(mesh)
}

/// Fails when a side line runs back along its piece of the path between two rings: the sides would cross there.
fn sides_forward(rings: &[Vec<V3>], pts: &[V3], tangents: &[V3], eps: f64) -> Result<()> {
    for k in 0..tangents.len() {
        let back = rings[k]
            .iter()
            .zip(&rings[k + 1])
            .any(|(&a, &b)| vec3::dot(vec3::sub(b, a), tangents[k]) <= eps);
        if back {
            let at = tightest(pts, tangents, k);
            return Err(Error::geometry(
                "sweep",
                format!(
                    "the path bends too tightly for the profile near ({:.2}, {:.2}, {:.2}) mm, so the sides would cross; use a wider bend or a smaller profile",
                    at[0], at[1], at[2]
                ),
            ));
        }
    }
    Ok(())
}

/// How far `dir` runs across the plane facing `normal`. Fails when that is within `MIN_START_DEG` of along the plane,
/// or the other way from `side` (any way when `side` is 0).
fn across(dir: V3, normal: V3, side: f64) -> Result<f64> {
    let d = vec3::dot(dir, normal);
    if d.abs() < MIN_START_DEG.to_radians().m_sin() || d * side < 0.0 {
        return Err(Error::invalid(
            "profile",
            format!(
                "the profile's plane is parallel to the path where the path starts (within {MIN_START_DEG} degree); turn the profile to face along the path"
            ),
        ));
    }
    Ok(d)
}

/// The points where the side lines through `at + offs[j]` along `dir` meet the plane through `origin` facing `normal`.
fn onto(offs: &[V3], at: V3, dir: V3, origin: V3, normal: V3) -> Vec<V3> {
    let den = vec3::dot(dir, normal);
    offs.iter()
        .map(|&o| {
            let p = vec3::add(at, o);
            let t = vec3::dot(vec3::sub(origin, p), normal) / den;
            vec3::add(p, vec3::scale(dir, t))
        })
        .collect()
}

/// `v` turned by the least rotation that takes direction `a` to direction `b`.
fn turned(v: V3, a: V3, b: V3) -> V3 {
    let axis = vec3::cross(a, b);
    let s = vec3::len(axis);
    if s < 1e-15 {
        return v;
    }
    let c = vec3::dot(a, b);
    let k = vec3::scale(axis, 1.0 / s);
    vec3::add(
        vec3::add(vec3::scale(v, c), vec3::scale(vec3::cross(k, v), s)),
        vec3::scale(k, vec3::dot(k, v) * (1.0 - c)),
    )
}

/// The corner of path piece `k` that turns the most: the bend that crossed its sides.
fn tightest(pts: &[V3], tangents: &[V3], k: usize) -> V3 {
    let bend = |i: usize| {
        if i == 0 || i + 1 >= pts.len() {
            f64::NEG_INFINITY
        } else {
            1.0 - vec3::dot(tangents[i - 1], tangents[i])
        }
    };
    if bend(k) > bend(k + 1) { pts[k] } else { pts[k + 1] }
}

/// The path's points in space (open, two or more, never crossing or doubling back on itself) and the directions it
/// starts and ends in.
fn path_points(path: &Path) -> Result<(Vec<V3>, V3, V3)> {
    let drawn: Vec<(usize, &Loop)> = path
        .loops
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.construction)
        .collect();
    let mut ends: Option<(V3, V3)> = None;
    let pts: Vec<V3> = match (drawn.as_slice(), path.points.is_empty()) {
        ([], true) => {
            return Err(Error::invalid(
                "path",
                "give the path as loops on a plane or as points",
            ));
        }
        ([_, ..], false) => return Err(Error::invalid("path", "give loops or points, not both")),
        ([], false) => {
            if let Some(i) = path.points.iter().position(|p| !p.iter().all(|c| c.is_finite())) {
                return Err(Error::invalid("path", format!("point {} is not a number", i + 1)));
            }
            path.points.clone()
        }
        ([(l, lp)], true) => {
            let frame = path
                .frame
                .unwrap_or_else(|| FaceFrame::bed([0.0, 0.0]))
                .checked()?;
            let c = sketch::open_chain(*l, lp).map_err(|i| Error::invalid("path", i.message))?;
            let dir = |d: V2| vec3::sub(frame.at(d, 0.0), frame.origin);
            ends = Some((dir(c.start_dir), dir(c.end_dir)));
            c.pts.into_iter().map(|p: V2| frame.at(p, 0.0)).collect()
        }
        (more, true) => {
            return Err(Error::invalid(
                "path",
                format!(
                    "a sweep path is one open chain of lines, arcs and splines, not {}",
                    more.len()
                ),
            ));
        }
    };
    if pts.len() < 2 {
        return Err(Error::invalid("path", "a sweep path needs 2 or more points"));
    }
    if pts.len() > MAX_PATH {
        return Err(Error::invalid(
            "path",
            format!("more than {MAX_PATH} points once its arcs are flattened"),
        ));
    }
    if let Some(i) = (1..pts.len()).find(|&i| vec3::len(vec3::sub(pts[i], pts[i - 1])) < MIN_STEP_MM) {
        return Err(Error::invalid(
            "path",
            format!("point {} is on the point before it", i + 1),
        ));
    }
    let m = pts.len();
    if vec3::len(vec3::sub(pts[m - 1], pts[0])) <= sketch::CLOSE_MM {
        return Err(Error::invalid(
            "path",
            "the path ends where it starts; a sweep path is open, with two ends",
        ));
    }
    no_crossing(&pts)?;
    let chord = |a: V3, b: V3| vec3::normalize(vec3::sub(b, a)).unwrap_or([0.0, 0.0, 1.0]);
    let (first, last) = (chord(pts[0], pts[1]), chord(pts[m - 2], pts[m - 1]));
    let (start, end) = ends.map_or((first, last), |(s, e)| {
        (
            vec3::normalize(s).unwrap_or(first),
            vec3::normalize(e).unwrap_or(last),
        )
    });
    Ok((pts, start, end))
}

/// Fails when the path doubles back at a corner or two of its pieces that are not neighbors meet.
fn no_crossing(pts: &[V3]) -> Result<()> {
    let m = pts.len();
    let size = pts
        .iter()
        .fold(0.0f64, |s, p| s.max(p[0].abs()).max(p[1].abs()).max(p[2].abs()))
        .max(1.0);
    let eps = size * 1e-9;
    for k in 1..m - 1 {
        let (a, b) = (vec3::sub(pts[k], pts[k - 1]), vec3::sub(pts[k + 1], pts[k]));
        let c = vec3::dot(a, b) / (vec3::len(a) * vec3::len(b));
        if c < -1.0 + 1e-12 {
            return Err(crosses(pts[k]));
        }
    }
    // pieces that are not neighbors must not meet; a box test first keeps this quick
    let boxes: Vec<(V3, V3)> = (0..m - 1)
        .map(|i| {
            let (a, b) = (pts[i], pts[i + 1]);
            (
                [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])],
                [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])],
            )
        })
        .collect();
    for i in 0..m - 1 {
        for j in i + 2..m - 1 {
            let (lo, hi) = (boxes[i], boxes[j]);
            if (0..3).any(|d| lo.1[d] + eps < hi.0[d] || hi.1[d] + eps < lo.0[d]) {
                continue;
            }
            let (d, at) = closest(pts[i], pts[i + 1], pts[j], pts[j + 1]);
            if d <= eps {
                return Err(crosses(at));
            }
        }
    }
    Ok(())
}

fn crosses(at: V3) -> Error {
    Error::invalid(
        "path",
        format!(
            "the path crosses or runs back over itself near ({:.2}, {:.2}, {:.2}) mm",
            at[0], at[1], at[2]
        ),
    )
}

/// The distance between segments `p0 p1` and `q0 q1`, and the point on the first nearest the second.
fn closest(p0: V3, p1: V3, q0: V3, q1: V3) -> (f64, V3) {
    let (d1, d2, r) = (vec3::sub(p1, p0), vec3::sub(q1, q0), vec3::sub(p0, q0));
    let (a, e, f) = (vec3::dot(d1, d1), vec3::dot(d2, d2), vec3::dot(d2, r));
    let c = vec3::dot(d1, r);
    let b = vec3::dot(d1, d2);
    let den = a * e - b * b;
    let mut s = if den > 1e-30 {
        ((b * f - c * e) / den).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let mut t = (b * s + f) / e;
    if t < 0.0 {
        t = 0.0;
        s = (-c / a).clamp(0.0, 1.0);
    } else if t > 1.0 {
        t = 1.0;
        s = ((b - c) / a).clamp(0.0, 1.0);
    }
    let on_p = vec3::add(p0, vec3::scale(d1, s));
    let on_q = vec3::add(q0, vec3::scale(d2, t));
    (vec3::len(vec3::sub(on_p, on_q)), on_p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::faces::Surface;
    use crate::sketch::Segment;
    use std::f64::consts::PI;

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

    fn on(frame: FaceFrame, l: Loop) -> Profile {
        Profile {
            frame: Some(frame),
            loops: vec![l],
            open: false,
            landmarks: Vec::new(),
        }
    }

    fn bed(l: Loop) -> Profile {
        Profile {
            frame: None,
            loops: vec![l],
            open: false,
            landmarks: Vec::new(),
        }
    }

    fn line(to: V2) -> Segment {
        Segment {
            kind: "line".into(),
            to: Some(to),
            ..Segment::default()
        }
    }

    fn arc(center: V2, sweep_deg: f64) -> Segment {
        Segment {
            kind: "arc".into(),
            center: Some(center),
            sweep_deg: Some(sweep_deg),
            ..Segment::default()
        }
    }

    /// An open chain on the bed.
    fn chain(start: V2, segments: Vec<Segment>) -> Path {
        Path {
            loops: vec![Loop {
                start: Some(start),
                segments,
                ..Loop::default()
            }],
            ..Path::default()
        }
    }

    fn points(p: &[V3]) -> Path {
        Path {
            points: p.to_vec(),
            ..Path::default()
        }
    }

    fn closed(m: &TriMesh) {
        let e = m.edge_report();
        assert!(e.is_watertight(), "{e:?}");
        assert_eq!(m.components().len(), 1);
        assert!(m.volume() > 0.0, "{}", m.volume());
    }

    /// The area of a regular polygon of `n` sides in a circle of radius `r`.
    fn ngon(n: usize, r: f64) -> f64 {
        n as f64 / 2.0 * r * r * (2.0 * PI / n as f64).m_sin()
    }

    #[test]
    fn a_straight_sweep_is_the_extrusion() {
        let m = sweep(
            &bed(square([0.0, 0.0], 10.0)),
            &points(&[[0.0, 0.0, 0.0], [0.0, 0.0, 25.0]]),
        )
        .unwrap();
        closed(&m);
        assert!((m.volume() - 2500.0).abs() < 1e-9, "{}", m.volume());
        let b = m.bounds().unwrap();
        assert_eq!((b.min, b.max), ([-5.0, -5.0, 0.0], [5.0, 5.0, 25.0]));
        // four flat sides, a top and a bottom
        let f = m.faces.as_ref().unwrap();
        assert_eq!(f.table.len(), 6);
        assert!(f.table.iter().all(|s| matches!(s, Surface::Plane { .. })));
    }

    #[test]
    fn a_profile_away_from_the_path_and_against_it_sweeps_the_same() {
        // the path runs down and starts 30 mm off; the profile is carried as it sits
        let m = sweep(
            &bed(square([0.0, 0.0], 10.0)),
            &points(&[[30.0, 0.0, 0.0], [30.0, 0.0, -25.0]]),
        )
        .unwrap();
        closed(&m);
        assert!((m.volume() - 2500.0).abs() < 1e-9, "{}", m.volume());
        assert!((m.bounds().unwrap().min[2] + 25.0).abs() < 1e-9);
    }

    #[test]
    fn a_tilted_profile_sweeps_an_oblique_prism() {
        let f = FaceFrame::for_normal([0.0, 0.0, 0.0], [0.6, 0.0, 0.8]).unwrap();
        let m = sweep(
            &on(f, square([0.0, 0.0], 10.0)),
            &points(&[[0.0, 0.0, 0.0], [0.0, 0.0, 20.0]]),
        )
        .unwrap();
        closed(&m);
        // the cross section is the square's area times the cosine of its tilt
        assert!((m.volume() - 100.0 * 0.8 * 20.0).abs() < 1e-9, "{}", m.volume());
    }

    #[test]
    fn a_quarter_arc_sweep_is_the_torus_segment() {
        // a 10 mm circle carried round a quarter of a 20 mm radius
        let (r, big) = (5.0, 20.0);
        let f = FaceFrame::for_normal([big, 0.0, 0.0], [0.0, 1.0, 0.0]).unwrap();
        let m = sweep(
            &on(f, circle([0.0, 0.0], 2.0 * r)),
            &chain([big, 0.0], vec![arc([0.0, 0.0], 90.0)]),
        )
        .unwrap();
        closed(&m);
        let torus = PI * r * r * big * PI / 2.0;
        assert!(
            (m.volume() / torus - 1.0).abs() < 2e-3,
            "{} vs {torus}",
            m.volume()
        );
        // exactly: the flattened circle's area times the flattened arc's length (mitered pieces keep the area)
        let c = sketch::circle_steps(r);
        let n = sketch::circle_steps(big) / 4;
        let chord = 2.0 * big * (PI / 4.0 / n as f64).m_sin();
        let exact = ngon(c, r) * chord * n as f64;
        assert!(
            (m.volume() - exact).abs() < 1e-6 * exact,
            "{} vs {exact}",
            m.volume()
        );
        // both caps are square to the arc: the start on x = 0's side at y = 0, the end on x = 0
        let b = m.bounds().unwrap();
        assert!(b.min[1].abs() < 1e-9 && b.min[0].abs() < 1e-9, "{b:?}");
        assert!(
            (b.max[1] - (big + r)).abs() < 5e-3 && (b.max[0] - (big + r)).abs() < 5e-3,
            "{b:?}"
        );
    }

    /// How many positions of `m` lie on the plane through `at` facing `normal`, within `reach` of `at`.
    fn on_plane(m: &TriMesh, at: V3, normal: V3, reach: f64) -> usize {
        m.positions
            .iter()
            .filter(|&&p| {
                let d = vec3::sub(p, at);
                vec3::dot(d, normal).abs() < 1e-9 && vec3::len(d) < reach
            })
            .count()
    }

    #[test]
    fn a_clockwise_quarter_arc_keeps_both_caps_square() {
        // a 10 mm circle at x = 20, facing -y, carried clockwise round the origin to y = -20
        let (r, big) = (5.0, 20.0);
        let f = FaceFrame::for_normal([big, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap();
        let m = sweep(
            &on(f, circle([0.0, 0.0], 2.0 * r)),
            &chain([big, 0.0], vec![arc([0.0, 0.0], -90.0)]),
        )
        .unwrap();
        closed(&m);
        let ring = sketch::circle_steps(r);
        let n = sketch::circle_steps(big) / 4;
        let exact = ngon(ring, r) * 2.0 * big * (PI / 4.0 / n as f64).m_sin() * n as f64;
        assert!(
            (m.volume() - exact).abs() < 1e-6 * exact,
            "{} vs {exact}",
            m.volume()
        );
        // the start cap is the profile on y = 0, the end cap lies on x = 0
        assert_eq!(on_plane(&m, [20.0, 0.0, 0.0], [0.0, 1.0, 0.0], 6.0), ring);
        assert_eq!(on_plane(&m, [0.0, -20.0, 0.0], [1.0, 0.0, 0.0], 6.0), ring);
    }

    #[test]
    fn clockwise_arcs_at_both_ends_of_a_chain_keep_the_caps_square() {
        // clockwise round the origin to (0, -20), a line to (-10, -20), then clockwise round (-10, -10) to (-20, -10)
        let r = 5.0;
        let f = FaceFrame::for_normal([20.0, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap();
        let path = chain(
            [20.0, 0.0],
            vec![
                arc([0.0, 0.0], -90.0),
                line([-10.0, -20.0]),
                arc([-10.0, -10.0], -90.0),
            ],
        );
        let m = sweep(&on(f, circle([0.0, 0.0], 2.0 * r)), &path).unwrap();
        closed(&m);
        let ring = sketch::circle_steps(r);
        assert_eq!(on_plane(&m, [20.0, 0.0, 0.0], [0.0, 1.0, 0.0], 6.0), ring);
        // the end arrives going +y, so its cap lies on y = -10
        assert_eq!(on_plane(&m, [-20.0, -10.0, 0.0], [0.0, 1.0, 0.0], 6.0), ring);
        let quarter = |big: f64| {
            let n = sketch::circle_steps(big) / 4;
            2.0 * big * (PI / 4.0 / n as f64).m_sin() * n as f64
        };
        let exact = ngon(ring, r) * (quarter(20.0) + 10.0 + quarter(10.0));
        assert!(
            (m.volume() - exact).abs() < 1e-6 * exact,
            "{} vs {exact}",
            m.volume()
        );
    }

    #[test]
    fn a_spline_path_starts_and_ends_square_to_its_curve() {
        // from (0, 0) through (10, 5) to (20, 0): it leaves along (10, 5) and arrives along (10, -5)
        let r = 2.0;
        let n0 = vec3::normalize([10.0, 5.0, 0.0]).unwrap();
        let n1 = vec3::normalize([10.0, -5.0, 0.0]).unwrap();
        let f = FaceFrame::for_normal([0.0, 0.0, 0.0], n0).unwrap();
        let spline = Segment {
            kind: "spline".into(),
            points: vec![[10.0, 5.0]],
            to: Some([20.0, 0.0]),
            ..Segment::default()
        };
        let m = sweep(
            &on(f, circle([0.0, 0.0], 2.0 * r)),
            &chain([0.0, 0.0], vec![spline]),
        )
        .unwrap();
        closed(&m);
        let ring = sketch::circle_steps(r);
        assert_eq!(on_plane(&m, [0.0, 0.0, 0.0], n0, 3.0), ring);
        assert_eq!(on_plane(&m, [20.0, 0.0, 0.0], n1, 3.0), ring);
    }

    #[test]
    fn the_profile_does_not_twist_along_a_path_in_space() {
        // a bent path that leaves its plane: the profile turns only as the path turns
        let path = points(&[
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 20.0],
            [20.0, 0.0, 20.0],
            [20.0, 20.0, 20.0],
            [20.0, 20.0, 40.0],
        ]);
        let m = sweep(&bed(square([0.0, 0.0], 4.0)), &path).unwrap();
        closed(&m);
        // mitered prisms: the area times the centerline
        assert!((m.volume() - 16.0 * 80.0).abs() < 1e-9, "{}", m.volume());
        let b = m.bounds().unwrap();
        assert!((b.max[2] - 40.0).abs() < 1e-9);
        // the last cap is the same square, still lined up with x and y
        let top: Vec<V3> = m
            .positions
            .iter()
            .copied()
            .filter(|p| (p[2] - 40.0).abs() < 1e-9)
            .collect();
        assert_eq!(top.len(), 4);
        for p in top {
            assert!(
                (p[0] - 20.0).abs() - 2.0 < 1e-9 && (p[1] - 20.0).abs() - 2.0 < 1e-9,
                "{p:?}"
            );
        }
    }

    #[test]
    fn a_sketch_path_of_lines_and_arcs_on_its_own_plane() {
        // drawn on the plane y = 0, facing -y: u is x, v is z
        let f = FaceFrame::for_normal([0.0, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap();
        let path = Path {
            frame: Some(f),
            loops: vec![Loop {
                start: Some([0.0, 0.0]),
                segments: vec![line([0.0, 10.0]), arc([10.0, 10.0], -90.0), line([30.0, 20.0])],
                ..Loop::default()
            }],
            ..Path::default()
        };
        let m = sweep(&bed(circle([0.0, 0.0], 4.0)), &path).unwrap();
        closed(&m);
        let b = m.bounds().unwrap();
        assert!((b.max[0] - 30.0).abs() < 1e-6, "{b:?}");
        assert!((b.max[2] - 22.0).abs() < 1e-6, "{b:?}");
    }

    #[test]
    fn says_what_is_wrong_with_the_profile() {
        let err = |p: &Profile, path: &Path| sweep(p, path).unwrap_err().to_string();
        let up = points(&[[0.0, 0.0, 0.0], [0.0, 0.0, 10.0]]);
        let sq = bed(square([0.0, 0.0], 10.0));
        let open = Loop {
            start: Some([0.0, 0.0]),
            segments: vec![line([10.0, 0.0]), line([10.0, 10.0])],
            ..Loop::default()
        };
        assert_eq!(
            err(&bed(open), &up),
            "profile: Loop 1 is open: segment 2 ends 14.142 mm from the start."
        );
        let holed = Profile {
            frame: None,
            loops: vec![square([0.0, 0.0], 10.0), square([0.0, 0.0], 4.0)],
            open: false,
            landmarks: Vec::new(),
        };
        assert_eq!(err(&holed, &up), "profile: a sweep profile has no holes yet");
        let two = Profile {
            frame: None,
            loops: vec![square([0.0, 0.0], 10.0), square([30.0, 0.0], 10.0)],
            open: false,
            landmarks: Vec::new(),
        };
        assert_eq!(
            err(&two, &up),
            "profile: a sweep profile is one closed loop, not 2"
        );
        let flat = points(&[[0.0, 0.0, 0.0], [10.0, 0.0, 0.0]]);
        assert_eq!(
            err(&sq, &flat),
            "profile: the profile's plane is parallel to the path where the path starts (within 1 degree); turn the profile to face along the path"
        );
    }

    #[test]
    fn says_what_is_wrong_with_the_path() {
        let err = |p: &Profile, path: &Path| sweep(p, path).unwrap_err().to_string();
        let sq = bed(square([0.0, 0.0], 10.0));
        let open = Loop {
            start: Some([0.0, 0.0]),
            segments: vec![line([10.0, 0.0]), line([10.0, 10.0])],
            ..Loop::default()
        };
        assert_eq!(
            err(&sq, &Path::default()),
            "path: give the path as loops on a plane or as points"
        );
        let round = Path {
            loops: vec![circle([0.0, 0.0], 10.0)],
            ..Path::default()
        };
        assert_eq!(err(&sq, &round), "path: Loop 1 is a circle, which has no ends.");
        let blob = Path {
            loops: vec![Loop {
                kind: Some("spline".into()),
                points: vec![[0.0, 0.0], [10.0, 0.0], [5.0, 8.0]],
                ..Loop::default()
            }],
            ..Path::default()
        };
        assert_eq!(
            err(&sq, &blob),
            "path: Loop 1 is a closed spline, which has no ends."
        );
        let ring = chain(
            [0.0, 0.0],
            vec![line([10.0, 0.0]), line([10.0, 10.0]), line([0.0, 0.0])],
        );
        assert_eq!(
            err(&sq, &ring),
            "path: the path ends where it starts; a sweep path is open, with two ends"
        );
        let bow = points(&[
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 20.0],
            [10.0, 0.0, 10.0],
            [-10.0, 0.0, 10.0],
        ]);
        assert_eq!(
            err(&sq, &bow),
            "path: the path crosses or runs back over itself near (0.00, 0.00, 10.00) mm"
        );
        let back = points(&[[0.0, 0.0, 0.0], [0.0, 0.0, 20.0], [0.0, 0.0, 5.0]]);
        assert_eq!(
            err(&sq, &back),
            "path: the path crosses or runs back over itself near (0.00, 0.00, 20.00) mm"
        );
        let both = Path {
            loops: vec![open],
            points: vec![[0.0; 3], [0.0, 0.0, 1.0]],
            ..Path::default()
        };
        assert_eq!(err(&sq, &both), "path: give loops or points, not both");
        assert_eq!(
            err(&sq, &points(&[[0.0, 0.0, 0.0]])),
            "path: a sweep path needs 2 or more points"
        );
        assert_eq!(
            err(&sq, &points(&[[0.0, 0.0, 0.0], [0.0, 0.0, 5.0], [0.0, 0.0, 5.0]])),
            "path: point 3 is on the point before it"
        );
        // facing 1.5 degrees across the arc's own start, but only 0.25 degrees across its first chord
        let a = 1.5f64.to_radians();
        let f = FaceFrame::for_normal([20.0, 0.0, 0.0], [a.m_cos(), a.m_sin(), 0.0]).unwrap();
        assert_eq!(
            err(
                &on(f, circle([0.0, 0.0], 10.0)),
                &chain([20.0, 0.0], vec![arc([0.0, 0.0], 10.0)]),
            ),
            "profile: the profile's plane is parallel to the path where the path starts (within 1 degree); turn the profile to face along the path"
        );
        // a 10 mm circle round a 3 mm bend: the inside sides would cross
        let f = FaceFrame::for_normal([3.0, 0.0, 0.0], [0.0, 1.0, 0.0]).unwrap();
        let e = err(
            &on(f, circle([0.0, 0.0], 10.0)),
            &chain([3.0, 0.0], vec![arc([0.0, 0.0], 90.0)]),
        );
        assert!(
            e.starts_with("sweep: the path bends too tightly for the profile near (")
                && e.ends_with(") mm, so the sides would cross; use a wider bend or a smaller profile"),
            "{e}"
        );
        // a square corner on a path too short for the profile's half width
        let e = err(
            &sq,
            &points(&[[0.0, 0.0, 0.0], [0.0, 0.0, 3.0], [20.0, 0.0, 3.0]]),
        );
        assert!(e.contains("near (0.00, 0.00, 3.00) mm"), "{e}");
        // a loop of square corners, each wide enough, whose last leg passes 3 mm from the first
        let near = points(&[
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 30.0],
            [30.0, 0.0, 30.0],
            [30.0, 3.0, 10.0],
            [-10.0, 3.0, 10.0],
        ]);
        assert_eq!(
            err(&sq, &near),
            "sweep: the swept body runs into itself where the path comes back near itself; move those parts of the path further apart or use a smaller profile"
        );
    }
}
