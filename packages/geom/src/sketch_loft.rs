// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a solid lofted through sketch profiles, each on its own plane: ruled or smooth sides, open or closed into a ring,
//! and open profiles thickened into a shell
// ring and vertex indices are taken modulo the ring length or come from the rings built here
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::face::FaceFrame;
use crate::faces::{Faces, Surface};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d::{self, Polygon};
use crate::sketch::{self, Loop};
use crate::thicken::{self, Thicken};
use crate::vec3::{self, Frame, V2, V3};
use serde::Deserialize;

/// The most profiles one loft takes.
pub const MAX_PROFILES: usize = 64;
/// The most points one profile's ring may have once its arcs are flattened.
const MAX_RING: usize = 4096;
/// The most points one smooth loft makes (ring points times rows).
const MAX_POINTS: usize = 1_000_000;
/// The farthest a smooth side strays from its flattened rows, mm: the sketch's own arc tolerance.
pub const SMOOTH_TOL_MM: f64 = 0.005;
/// How far a landmark may sit from its profile, mm: twice the arc tolerance, so a point on a flattened arc counts.
const LANDMARK_TOL_MM: f64 = 0.01;
/// The most landmarks one profile marks.
pub const MAX_LANDMARKS: usize = 64;
/// The most rows one smooth span between two profiles takes; one that needs more is refused, so the tolerance holds.
const MAX_SPAN_ROWS: usize = 1024;

/// One section of a loft or a sweep: sketch loops on a plane (the bed when `frame` is absent). A closed profile is one
/// closed loop; an open one (`open`) is one chain with two ends, its `points` a polyline, and makes a surface that
/// `thicken` turns into a solid.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(default)]
    pub frame: Option<FaceFrame>,
    pub loops: Vec<Loop>,
    #[serde(default)]
    pub open: bool,
    /// Points on the profile (in its plane) that match the same points on every other profile, in order along it, such
    /// as a hull station's keel, bilge, waterline and sheer. Each run between two of them is spread evenly over the
    /// same number of points on every profile, so matching features stay matched. Mark corners as landmarks.
    #[serde(default)]
    pub landmarks: Vec<V2>,
}

/// How a loft runs through its profiles.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// The sides follow a smooth curve through the profiles (centripetal Catmull-Rom through matching points) instead
    /// of straight lines from each profile to the next.
    pub smooth: bool,
    /// The last profile joins the first, making a ring with no caps.
    pub closed: bool,
    /// Make the sides a shell this thick, with no caps; needed when the profiles are open.
    pub thicken: Option<Thicken>,
}

/// A ring in 3D with the plane it lies on.
pub(crate) struct Section {
    pub(crate) ring: Vec<V3>,
    /// The ring's points in its own plane, in the same order.
    pub(crate) flat: Vec<V2>,
    pub(crate) frame: Frame,
    pub(crate) center: V3,
}

/// The solid through `profiles` in order: ruled sides from each profile to the next and flat caps on the first and
/// last. Each profile is one closed loop without holes. The rings are matched point to point with each ring's own
/// corners kept, turned to wind the same way along the loft and rotated to the least twist.
pub fn loft(profiles: &[Profile]) -> Result<TriMesh> {
    loft_with(profiles, &Options::default())
}

/// The loft through `profiles` as `opts` asks: smooth sides through the profiles, the last joined back to the first,
/// or the sides thickened into a shell (which open profiles need).
#[allow(
    clippy::too_many_lines,
    reason = "one pass from the profiles to the mesh, each step named"
)]
pub fn loft_with(profiles: &[Profile], opts: &Options) -> Result<TriMesh> {
    let least = if opts.closed { 3 } else { 2 };
    if profiles.len() < least {
        return Err(Error::invalid(
            "profiles",
            if opts.closed {
                "a closed loft needs 3 or more profiles"
            } else {
                "a loft needs 2 or more profiles"
            },
        ));
    }
    if profiles.len() > MAX_PROFILES {
        return Err(Error::invalid(
            "profiles",
            format!("a loft takes at most {MAX_PROFILES} profiles"),
        ));
    }
    let open = profiles[0].open;
    if let Some(k) = profiles.iter().position(|p| p.open != open) {
        return Err(Error::invalid(
            "profiles",
            format!(
                "profile {} is {} and profile 1 is {}; a loft's profiles are all closed or all open",
                k + 1,
                if open { "closed" } else { "open" },
                if open { "open" } else { "closed" }
            ),
        ));
    }
    if open && opts.thicken.is_none() {
        return Err(Error::invalid(
            "thicken",
            "open profiles make a surface; give thicken to make it a solid",
        ));
    }
    let mut rings = Vec::with_capacity(profiles.len());
    for (k, p) in profiles.iter().enumerate() {
        rings.push((frame_of(p)?, ring_of(k, p)?));
    }
    let marked = landmarked(profiles)?;
    let flats: Vec<Vec<V2>> = if marked {
        // which way each plane faces along the loft, and each profile's middle, from its points as drawn
        let centers: Vec<V3> = rings
            .iter()
            .map(|(f, r)| centroid(&r.iter().map(|&p| f.at(p, 0.0)).collect::<Vec<V3>>()))
            .collect();
        let way = alongs(&centers, opts.closed);
        let facing: Vec<V3> = rings
            .iter()
            .zip(&way)
            .map(|((f, _), a)| toward(f.w, *a))
            .collect();
        by_landmarks(profiles, &rings, open, &facing, &centers)?
    } else {
        let n = rings.iter().map(|(_, r)| r.len()).max().unwrap_or(0);
        rings.iter().map(|(_, r)| resample(r, n, !open)).collect()
    };
    let mut sections: Vec<Section> = rings
        .iter()
        .zip(flats)
        .map(|((frame, _), flat)| {
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
    let count = sections.len();
    // the way the loft goes at each profile
    let along = alongs(
        &sections.iter().map(|s| s.center).collect::<Vec<V3>>(),
        opts.closed,
    );
    // Every closed ring winds counterclockwise about the way the loft goes from it. Open chains all run one way: the
    // first that bends winds the way it and the line across its ends go around, and the rest run the way their
    // neighbors run, taken as the planes turn between them. Landmarked rings keep their matched points, so they turn
    // all together or not at all.
    let facing: Vec<V3> = sections
        .iter()
        .zip(&along)
        .map(|(s, a)| toward(s.frame.w, *a))
        .collect();
    if marked {
        same_way(&mut sections, &along, open);
    } else {
        orient(&mut sections, &along, &facing, open);
    }
    // open chains joined end to end around a ring must meet the first the same way when they come back to it; two or
    // more landmarks set every chain's way, so there the person has said how the ring closes
    let set = marked && profiles[0].landmarks.len() >= 2;
    if open
        && opts.closed
        && !set
        && crossed(&sections[count - 1], &sections[0], facing[count - 1], facing[0])
    {
        return Err(Error::geometry(
            "loft",
            format!(
                "profile {count} meets profile 1 the other way around where the ring closes, so its sides would cross; turn the profiles so they line up around the ring"
            ),
        ));
    }
    let pairs = if opts.closed { count } else { count - 1 };
    for k in 0..pairs {
        let j = (k + 1) % count;
        apart(&sections[k], &sections[j], facing[k], facing[j], (k, j), eps)?;
    }
    if !open && !marked {
        for k in 1..count {
            let shift = least_twist(&sections[k - 1], &sections[k]);
            sections[k].ring.rotate_left(shift);
            sections[k].flat.rotate_left(shift);
        }
    }
    // a ring of closed profiles joins its last to its first at the least twist; open chains join end to end
    let wrap = (opts.closed).then(|| {
        if open || marked {
            0
        } else {
            least_twist(&sections[count - 1], &sections[0])
        }
    });
    let (rows, spans) = if opts.smooth {
        smooth_rows(&sections, wrap)?
    } else {
        (
            sections.iter().map(|s| s.ring.clone()).collect(),
            (0..count).collect(),
        )
    };
    let caps = (!opts.closed && opts.thicken.is_none()).then(|| (&sections[0], &sections[count - 1]));
    let surface = build_rows(&rows, &spans, !open, wrap, caps, size)?;
    if let Some(t) = &opts.thicken {
        return thicken::thicken(&surface, t);
    }
    if (opts.smooth || opts.closed) && crate::boolean::Solid::new(&surface).is_ok_and(|s| s.self_intersects())
    {
        return Err(Error::geometry(
            "loft",
            "the lofted body runs into itself; space the profiles further apart or make them smaller",
        ));
    }
    Ok(surface)
}

/// The way the loft goes at each profile, from the profiles' middles; a `closed` loft runs around.
fn alongs(centers: &[V3], closed: bool) -> Vec<V3> {
    let count = centers.len();
    (0..count)
        .map(|k| {
            if closed {
                vec3::sub(centers[(k + 1) % count], centers[(k + count - 1) % count])
            } else if k + 1 < count {
                vec3::sub(centers[k + 1], centers[k])
            } else {
                vec3::sub(centers[k], centers[k - 1])
            }
        })
        .collect()
}

/// Turns each ring to run the way the loft needs; see [`loft_with`].
fn orient(sections: &mut [Section], along: &[V3], facing: &[V3], open: bool) {
    let count = sections.len();
    if !open {
        for (s, a) in sections.iter_mut().zip(along) {
            if vec3::dot(s.frame.w, *a) < 0.0 {
                s.ring.reverse();
                s.flat.reverse();
            }
        }
        return;
    }
    // the first chain that bends sets the way; a chain that bends the other way still runs as its neighbor does
    let first = sections
        .iter()
        .position(|s| chain_winds(&s.flat).is_some())
        .unwrap_or(0);
    if !winds_along(&sections[first], along[first]).unwrap_or(true) {
        sections[first].ring.reverse();
        sections[first].flat.reverse();
    }
    for k in (0..first).rev() {
        follow(sections, facing, k, k + 1);
    }
    for k in first + 1..count {
        follow(sections, facing, k, k - 1);
    }
}

/// Whether an open chain and the line across its ends go around counterclockwise, or None for a straight chain.
fn chain_winds(flat: &[V2]) -> Option<bool> {
    let a = poly2d::signed_area(flat);
    let span = flat
        .iter()
        .fold(0.0f64, |m, p| m.max(p[0].abs()).max(p[1].abs()))
        .max(1.0);
    (a.abs() > span * span * 1e-9).then_some(a > 0.0)
}

/// Whether a section winds counterclockwise about `along` (None for a straight open chain).
fn winds_along(s: &Section, along: V3) -> Option<bool> {
    chain_winds(&s.flat).map(|ccw| ccw == (vec3::dot(s.frame.w, along) >= 0.0))
}

/// Turns every landmarked ring end for end when the first that winds at all winds clockwise about `along`. Their
/// landmarks already run the same way (see [`by_landmarks`]), so they turn all together.
fn same_way(sections: &mut [Section], along: &[V3], open: bool) {
    let turn = sections
        .iter()
        .zip(along)
        .find_map(|(s, a)| winds_along(s, *a))
        .is_some_and(|ok| !ok);
    if turn {
        for s in sections.iter_mut() {
            s.ring.reverse();
            s.flat.reverse();
            if !open {
                // the first landmark stays the first point
                s.ring.rotate_right(1);
                s.flat.rotate_right(1);
            }
        }
    }
}

/// Whether the profiles mark landmarks: all of them the same number, or none.
fn landmarked(profiles: &[Profile]) -> Result<bool> {
    let first = profiles[0].landmarks.len();
    if let Some(k) = profiles.iter().position(|p| p.landmarks.len() != first) {
        return Err(Error::invalid(
            "profiles",
            format!(
                "profile {} marks {} landmarks and profile 1 marks {first}; every profile marks the same landmarks",
                k + 1,
                profiles[k].landmarks.len()
            ),
        ));
    }
    if first > MAX_LANDMARKS {
        return Err(Error::invalid(
            "profiles",
            format!("a profile marks at most {MAX_LANDMARKS} landmarks"),
        ));
    }
    Ok(first > 0)
}

/// Where `p` lies along the polyline `pts` (closed around when `closed`), as a length from its start, when it is within
/// `LANDMARK_TOL_MM` of it.
fn along_of(pts: &[V2], closed: bool, p: V2) -> Option<f64> {
    let k = pts.len();
    let sides = if closed { k } else { k - 1 };
    let mut run = 0.0;
    let mut best: Option<(f64, f64)> = None;
    for i in 0..sides {
        let (a, b) = (pts[i], pts[(i + 1) % k]);
        let d = [b[0] - a[0], b[1] - a[1]];
        let l2 = d[0] * d[0] + d[1] * d[1];
        let t = if l2 > 0.0 {
            (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let q = [a[0] + d[0] * t, a[1] + d[1] * t];
        let off = (p[0] - q[0]).m_hypot(p[1] - q[1]);
        let l = l2.sqrt();
        if best.is_none_or(|(o, _)| off < o) {
            best = Some((off, run + l * t));
        }
        run += l;
    }
    best.filter(|&(o, _)| o <= LANDMARK_TOL_MM).map(|(_, s)| s)
}

/// A polyline measured along its length: where each point is, and how long it is (back to the start when closed).
struct Measured<'a> {
    pts: &'a [V2],
    closed: bool,
    at: Vec<f64>,
    total: f64,
}

impl<'a> Measured<'a> {
    fn new(pts: &'a [V2], closed: bool) -> Self {
        let n = pts.len();
        let mut at = Vec::with_capacity(n);
        let mut run = 0.0;
        for i in 0..n {
            at.push(run);
            if closed || i + 1 < n {
                let (a, b) = (pts[i], pts[(i + 1) % n]);
                run += (b[0] - a[0]).m_hypot(b[1] - a[1]);
            }
        }
        Self {
            pts,
            closed,
            at,
            total: run,
        }
    }

    /// The point `s` along it: taken around a closed one, held to the ends of an open one.
    fn point(&self, s: f64) -> V2 {
        let n = self.pts.len();
        let s = if self.closed {
            s.rem_euclid(self.total)
        } else {
            s.clamp(0.0, self.total)
        };
        let i = self.at.partition_point(|&a| a <= s).saturating_sub(1);
        let i = if self.closed { i } else { i.min(n - 2) };
        let (a, b) = (self.pts[i], self.pts[(i + 1) % n]);
        let len = if i + 1 < n { self.at[i + 1] } else { self.total } - self.at[i];
        let t = if len > 0.0 {
            ((s - self.at[i]) / len).clamp(0.0, 1.0)
        } else {
            0.0
        };
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
}

/// The rings matched by their landmarks. Each profile's points are split at its landmarks (an open chain's ends are
/// landmarks too, and a landmark within `LANDMARK_TOL_MM` of an end is that end; a closed ring starts at its first),
/// and each run between two landmarks is spread evenly by length over the same number of points on every profile: the
/// most that run has on any profile.
///
/// The landmarks' order sets the way each ring runs when it can: three or more on a closed ring, two or more on an open
/// chain, ends included. A ring with fewer runs the way the others do: a closed one winds about the loft as they do
/// (`facing`: each plane's normal along the loft), and an open one starts at the end nearest its neighbor's start,
/// each taken about its middle (`centers`) as the planes turn between them. Closed rings whose landmarks wind opposite
/// ways are refused, and so are open chains whose landmarks are not at the same ends or between them.
#[allow(
    clippy::too_many_lines,
    reason = "find the landmarks, settle each ring's way, count each run, then spread it"
)]
fn by_landmarks(
    profiles: &[Profile],
    rings: &[(Frame, Vec<V2>)],
    open: bool,
    facing: &[V3],
    centers: &[V3],
) -> Result<Vec<Vec<V2>>> {
    let count = rings.len();
    let lines: Vec<Measured<'_>> = rings.iter().map(|(_, pts)| Measured::new(pts, !open)).collect();
    // each landmark's place along its profile, in the order given
    let mut places: Vec<Vec<f64>> = Vec::with_capacity(count);
    for (k, (line, p)) in lines.iter().zip(profiles).enumerate() {
        let bad = |why: String| Error::invalid("profiles", format!("profile {}: {why}", k + 1));
        let mut at = Vec::with_capacity(p.landmarks.len());
        for (j, &l) in p.landmarks.iter().enumerate() {
            let mut s = along_of(line.pts, !open, l).ok_or_else(|| {
                bad(format!(
                    "landmark {} at ({:.3}, {:.3}) is not on the profile",
                    j + 1,
                    l[0],
                    l[1]
                ))
            })?;
            if open {
                if s <= LANDMARK_TOL_MM {
                    s = 0.0;
                } else if line.total - s <= LANDMARK_TOL_MM {
                    s = line.total;
                }
            }
            at.push(s);
        }
        places.push(at);
    }
    // each ring's way where its landmarks set it: forward (true) or backward
    let mut ways: Vec<Option<bool>> = Vec::with_capacity(count);
    for (k, (line, at)) in lines.iter().zip(&places).enumerate() {
        let bad = |why: &str| Error::invalid("profiles", format!("profile {}: {why}", k + 1));
        let eps = line.total * 1e-9;
        let rising = |v: &[f64]| v.windows(2).all(|w| w[1] - w[0] > eps);
        if open {
            let back: Vec<f64> = at.iter().rev().copied().collect();
            ways.push(if at.len() < 2 {
                None
            } else if rising(at) {
                Some(true)
            } else if rising(&back) {
                Some(false)
            } else {
                return Err(bad("its landmarks are not in order along it"));
            });
        } else {
            let s0 = at[0];
            let fwd: Vec<f64> = at.iter().map(|&s| (s - s0).rem_euclid(line.total)).collect();
            let back: Vec<f64> = fwd
                .iter()
                .map(|&s| (line.total - s).rem_euclid(line.total))
                .collect();
            let (f, b) = (rising(&fwd), rising(&back));
            if !f && !b {
                return Err(bad("its landmarks are not in order around it"));
            }
            ways.push((at.len() >= 3).then_some(f));
        }
    }
    let mut way = vec![true; count];
    if open {
        // a ring whose landmarks do not set its way starts at the end nearest its neighbor's start
        let ends = |k: usize, fwd: bool| -> (V3, V3) {
            let (f, pts) = (&rings[k].0, &rings[k].1);
            let (a, b) = (pts[0], pts[pts.len() - 1]);
            let (a, b) = if fwd { (a, b) } else { (b, a) };
            (
                vec3::sub(f.at(a, 0.0), centers[k]),
                vec3::sub(f.at(b, 0.0), centers[k]),
            )
        };
        let first = ways.iter().position(Option::is_some).unwrap_or(0);
        way[first] = ways[first].unwrap_or(true);
        let settle = |k: usize, to: usize, way: &mut Vec<bool>| {
            way[k] = ways[k].unwrap_or_else(|| {
                let (s, e) = ends(to, way[to]);
                let (s, e) = (turned(s, facing[to], facing[k]), turned(e, facing[to], facing[k]));
                let cost = |fwd: bool| {
                    let (a, b) = ends(k, fwd);
                    let (x, y) = (vec3::sub(a, s), vec3::sub(b, e));
                    vec3::dot(x, x) + vec3::dot(y, y)
                };
                cost(true) <= cost(false)
            });
        };
        for k in (0..first).rev() {
            settle(k, k + 1, &mut way);
        }
        for k in first + 1..count {
            settle(k, k - 1, &mut way);
        }
    } else {
        // closed rings all wind one way about the loft: the way the first whose landmarks set it winds
        let winds = |k: usize, fwd: bool| fwd == (vec3::dot(rings[k].0.w, facing[k]) > 0.0);
        let set = ways.iter().position(Option::is_some);
        let want = set.is_none_or(|r| winds(r, ways[r].unwrap_or(true)));
        for k in 0..count {
            way[k] = match ways[k] {
                Some(fwd) if winds(k, fwd) != want => {
                    return Err(Error::invalid(
                        "profiles",
                        format!(
                            "profile {}'s landmarks run around the other way from profile {}'s; list them in the same order on every profile",
                            k + 1,
                            set.unwrap_or(0) + 1
                        ),
                    ));
                }
                Some(fwd) => fwd,
                None => winds(k, true) == want,
            };
        }
    }
    // where each run starts and ends along its profile, the way the ring runs
    let mut breaks: Vec<Vec<f64>> = Vec::with_capacity(count);
    for ((line, at), &fwd) in lines.iter().zip(&places).zip(&way) {
        let t = line.total;
        let eps = t * 1e-9;
        let b = if open {
            let mut inner: Vec<f64> = at.iter().copied().filter(|&s| s > eps && s < t - eps).collect();
            inner.sort_by(f64::total_cmp);
            let mut b = vec![0.0];
            b.extend(inner);
            b.push(t);
            if !fwd {
                b.reverse();
            }
            b
        } else {
            let s0 = at[0];
            let dir = if fwd { 1.0 } else { -1.0 };
            let mut b: Vec<f64> = at
                .iter()
                .map(|&s| s0 + dir * (dir * (s - s0)).rem_euclid(t))
                .collect();
            b.push(s0 + dir * t);
            b
        };
        breaks.push(b);
    }
    if let Some(k) = breaks.iter().position(|b| b.len() != breaks[0].len()) {
        return Err(Error::invalid(
            "profiles",
            format!(
                "profile {} and profile 1 mark different numbers of landmarks between their ends ({} and {}); mark the same points on every profile",
                k + 1,
                breaks[k].len() - 2,
                breaks[0].len() - 2
            ),
        ));
    }
    if open {
        // each landmark is the chain's start, its end or between them, taken the way the chain runs
        const PLACES: [&str; 3] = ["at its start", "between its ends", "at its end"];
        let place = |k: usize, s: f64| {
            let p = if s <= 0.0 {
                0
            } else if s >= lines[k].total {
                2
            } else {
                1
            };
            if way[k] { p } else { 2 - p }
        };
        for k in 1..count {
            let odd = places[0]
                .iter()
                .zip(&places[k])
                .position(|(&a, &b)| place(0, a) != place(k, b));
            if let Some(j) = odd {
                return Err(Error::invalid(
                    "profiles",
                    format!(
                        "profile {}'s landmark {} is {} and profile 1's is {}; mark the same points on every profile",
                        k + 1,
                        j + 1,
                        PLACES[place(k, places[k][j])],
                        PLACES[place(0, places[0][j])]
                    ),
                ));
            }
        }
    }
    let runs = breaks[0].len() - 1;
    // each run's count: the most points it has on any profile, one more than its inner vertices
    let mut counts = vec![1usize; runs];
    for (line, b) in lines.iter().zip(&breaks) {
        let t = line.total;
        for (j, c) in counts.iter_mut().enumerate() {
            let (lo, hi) = (b[j].min(b[j + 1]), b[j].max(b[j + 1]));
            let inner = line
                .at
                .iter()
                .filter(|&&v| [v, v + t, v - t].iter().any(|&w| w > lo + 1e-9 && w < hi - 1e-9))
                .count();
            *c = (*c).max(inner + 1);
        }
    }
    let n = counts.iter().sum::<usize>() + usize::from(open);
    if n > MAX_RING {
        return Err(Error::invalid(
            "profiles",
            format!("the landmarked profiles would have more than {MAX_RING} points each"),
        ));
    }
    let mut out = Vec::with_capacity(count);
    for (line, b) in lines.iter().zip(&breaks) {
        let mut ring = Vec::with_capacity(n);
        for (j, &c) in counts.iter().enumerate() {
            for i in 0..c {
                #[allow(clippy::cast_precision_loss, reason = "counts are small")]
                let t = i as f64 / c as f64;
                ring.push(line.point(b[j] + (b[j + 1] - b[j]) * t));
            }
        }
        if open {
            ring.push(line.point(b[runs]));
        }
        out.push(ring);
    }
    Ok(out)
}

/// Turns section `k` end for end when that lines it up better with section `to`; see [`crossed`].
fn follow(sections: &mut [Section], facing: &[V3], k: usize, to: usize) {
    if crossed(&sections[to], &sections[k], facing[to], facing[k]) {
        sections[k].ring.reverse();
        sections[k].flat.reverse();
    }
}

/// Whether `b` lines up better with `a` end for end, each taken about its own center and `a` turned as the planes turn
/// between them (`na`, `nb`: each plane's normal along the loft).
fn crossed(a: &Section, b: &Section, na: V3, nb: V3) -> bool {
    let n = a.ring.len();
    let cost = |rev: bool| -> f64 {
        (0..n)
            .map(|i| {
                let j = if rev { n - 1 - i } else { i };
                let e = vec3::sub(
                    turned(vec3::sub(a.ring[i], a.center), na, nb),
                    vec3::sub(b.ring[j], b.center),
                );
                vec3::dot(e, e)
            })
            .sum()
    };
    cost(true) < cost(false)
}

/// A plane's normal `w` turned to face the way the loft goes (`along`).
fn toward(w: V3, along: V3) -> V3 {
    if vec3::dot(w, along) < 0.0 {
        vec3::scale(w, -1.0)
    } else {
        w
    }
}

/// `v` turned by the least rotation that takes the unit `from` onto the unit `to`, or as it is when they point opposite
/// ways (two planes whose normals face opposite ways about the loft), which no one rotation settles.
fn turned(v: V3, from: V3, to: V3) -> V3 {
    let (w, c) = (vec3::cross(from, to), vec3::dot(from, to));
    if c <= -1.0 + 1e-9 {
        return v;
    }
    // Rodrigues' rotation with the axis scaled by the sine
    vec3::add(
        vec3::add(vec3::scale(v, c), vec3::cross(w, v)),
        vec3::scale(w, vec3::dot(w, v) / (1.0 + c)),
    )
}

fn frame_of(p: &Profile) -> Result<Frame> {
    p.frame.unwrap_or_else(|| FaceFrame::bed([0.0, 0.0])).checked()
}

/// The profile's points in its plane: a closed ring counterclockwise, or an open chain as drawn.
fn ring_of(k: usize, p: &Profile) -> Result<Vec<V2>> {
    let r = if p.open {
        open_ring(&p.loops, "loft")
    } else {
        one_ring(&p.loops, "loft")
    };
    r.map_err(|why| Error::invalid("profiles", format!("profile {}: {why}", k + 1)))
}

/// The one open chain of a `verb` ("loft", "sweep") profile, from its start to its end, or why there is none.
pub(crate) fn open_ring(loops: &[Loop], verb: &str) -> std::result::Result<Vec<V2>, String> {
    let drawn: Vec<(usize, &Loop)> = loops
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.construction)
        .collect();
    let (l, lp) = match drawn.as_slice() {
        [] => return Err(format!("nothing to {verb}")),
        [one] => *one,
        more => {
            return Err(format!("an open {verb} profile is one chain, not {}", more.len()));
        }
    };
    let pts = sketch::open_chain(l, lp).map_err(|i| i.message)?.pts;
    let (Some(&first), Some(&last)) = (pts.first(), pts.last()) else {
        return Err(format!("nothing to {verb}"));
    };
    if pts.len() < 2 {
        return Err("an open profile needs 2 or more points".into());
    }
    if (last[0] - first[0]).m_hypot(last[1] - first[1]) <= sketch::CLOSE_MM {
        return Err("it ends where it starts, so it is closed; leave open out".into());
    }
    if pts.len() > MAX_RING {
        return Err(format!("more than {MAX_RING} points once its arcs are flattened"));
    }
    Ok(pts)
}

/// The one closed ring of a `verb` ("loft", "sweep") profile, counterclockwise in its plane, or why there is none.
pub(crate) fn one_ring(loops: &[Loop], verb: &str) -> std::result::Result<Vec<V2>, String> {
    let c = sketch::check(loops);
    if let Some(i) = c.issues.into_iter().next() {
        return Err(i.message);
    }
    let mut polys: Vec<Polygon> = c.polygons;
    let Some(mut poly) = polys.pop() else {
        return Err(format!("nothing to {verb}"));
    };
    if !polys.is_empty() {
        return Err(format!(
            "a {verb} profile is one closed loop, not {}",
            polys.len() + 1
        ));
    }
    if !poly.holes.is_empty() {
        return Err(format!("a {verb} profile has no holes yet"));
    }
    poly.normalize_orientation();
    if poly.outer.len() > MAX_RING {
        return Err(format!("more than {MAX_RING} points once its arcs are flattened"));
    }
    Ok(poly.outer)
}

/// `ring` with `n` points: its own points all kept, and the points it lacks spread over its sides by their length.
/// A `closed` ring has a side from its last point back to its first; an open chain does not.
fn resample(ring: &[V2], n: usize, closed: bool) -> Vec<V2> {
    let k = ring.len();
    if n <= k {
        return ring.to_vec();
    }
    let sides = if closed { k } else { k - 1 };
    let lens: Vec<f64> = (0..sides)
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
    let mut order: Vec<usize> = (0..sides).collect();
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
    for i in 0..sides {
        let (a, b) = (ring[i], ring[(i + 1) % k]);
        out.push(a);
        let m = counts[i];
        for j in 1..=m {
            let t = j as f64 / (m + 1) as f64;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    }
    if !closed {
        out.push(ring[k - 1]);
    }
    out
}

pub(crate) fn centroid(ring: &[V3]) -> V3 {
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

/// Fails when neighboring profiles `a` and `b` (numbered `ids`, from 0) touch or cross: each must lie wholly ahead of
/// the other's plane, facing `na` and `nb` the way the loft goes.
fn apart(a: &Section, b: &Section, na: V3, nb: V3, ids: (usize, usize), eps: f64) -> Result<()> {
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
                ids.0 + 1,
                ids.1 + 1
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

/// The knot step of centripetal Catmull-Rom: the square root of the chord, so a span has no cusp or loop.
fn knot(a: V3, b: V3) -> f64 {
    vec3::len(vec3::sub(b, a)).sqrt().max(1e-12)
}

/// The cubic Bezier of the centripetal Catmull-Rom span from `p1` to `p2`, with `p0` before it and `p3` after. Its
/// tangents at the ends are scaled to the span, so two spans meeting at a point leave it in the same direction.
pub(crate) fn span(p0: V3, p1: V3, p2: V3, p3: V3) -> [V3; 4] {
    let (t01, t12, t23) = (knot(p0, p1), knot(p1, p2), knot(p2, p3));
    let m = |i: usize| {
        let m1 = p2[i] - p1[i] + t12 * ((p1[i] - p0[i]) / t01 - (p2[i] - p0[i]) / (t01 + t12));
        let m2 = p2[i] - p1[i] + t12 * ((p3[i] - p2[i]) / t23 - (p3[i] - p1[i]) / (t12 + t23));
        (m1, m2)
    };
    let (m1, m2): (V3, V3) = {
        let (a, b, c) = (m(0), m(1), m(2));
        ([a.0, b.0, c.0], [a.1, b.1, c.1])
    };
    [
        p1,
        vec3::add(p1, vec3::scale(m1, 1.0 / 3.0)),
        vec3::sub(p2, vec3::scale(m2, 1.0 / 3.0)),
        p2,
    ]
}

/// The point at `t` (0 to 1) along a cubic Bezier.
pub(crate) fn bezier_at(b: &[V3; 4], t: f64) -> V3 {
    let u = 1.0 - t;
    let w = [u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t];
    (0..4).fold([0.0; 3], |s, k| vec3::add(s, vec3::scale(b[k], w[k])))
}

/// The steps that keep every chord of the span within `SMOOTH_TOL_MM` of it: a polyline strays at most an eighth of
/// the step squared times the largest second derivative.
fn steps(b: &[V3; 4]) -> f64 {
    let dd =
        |i: usize, j: usize, k: usize| vec3::len(vec3::add(vec3::sub(b[i], vec3::scale(b[j], 2.0)), b[k]));
    let most = 6.0 * dd(0, 1, 2).max(dd(1, 2, 3));
    (most / (8.0 * SMOOTH_TOL_MM)).sqrt().ceil().max(1.0)
}

/// The rows of a smooth loft and the span each row's strip to the next belongs to. Each ring point follows its own
/// centripetal Catmull-Rom curve through the matching point of every profile; an open loft's ends mirror their
/// neighbors, and a ring (`wrap`, the last ring's start on the first) runs around. Every span is cut into as many rows
/// as its most bent curve needs to stay within the tolerance.
fn smooth_rows(sections: &[Section], wrap: Option<usize>) -> Result<(Vec<Vec<V3>>, Vec<usize>)> {
    let count = sections.len();
    let n = sections[0].ring.len();
    #[allow(
        clippy::cast_possible_wrap,
        clippy::cast_sign_loss,
        reason = "profile and ring counts are small"
    )]
    let pt = |k: isize, i: usize| -> V3 {
        let c = count as isize;
        if let Some(shift) = wrap {
            let laps = k.div_euclid(c);
            let at = (i as isize + laps * shift as isize).rem_euclid(n as isize) as usize;
            return sections[k.rem_euclid(c) as usize].ring[at];
        }
        let mirror = |a: V3, b: V3| vec3::sub(vec3::scale(a, 2.0), b);
        if k < 0 {
            mirror(sections[0].ring[i], sections[1].ring[i])
        } else if k >= c {
            mirror(sections[count - 1].ring[i], sections[count - 2].ring[i])
        } else {
            sections[k as usize].ring[i]
        }
    };
    let spans = if wrap.is_some() { count } else { count - 1 };
    let mut rows = Vec::new();
    let mut of = Vec::new();
    #[allow(
        clippy::needless_range_loop,
        reason = "a ring's spans run around past its last section"
    )]
    for s in 0..spans {
        #[allow(clippy::cast_possible_wrap, reason = "profile counts are small")]
        let k = s as isize;
        let curves: Vec<[V3; 4]> = (0..n)
            .map(|i| span(pt(k - 1, i), pt(k, i), pt(k + 1, i), pt(k + 2, i)))
            .collect();
        let most = curves.iter().map(steps).fold(1.0f64, f64::max);
        #[allow(clippy::cast_precision_loss, reason = "a small constant")]
        if most > MAX_SPAN_ROWS as f64 {
            return Err(Error::geometry(
                "loft",
                format!(
                    "the smooth sides bend too sharply between profiles {} and {}; space them more evenly or make the change between them smaller",
                    s + 1,
                    (s + 1) % count + 1
                ),
            ));
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "checked against MAX_SPAN_ROWS"
        )]
        let m = most as usize;
        if (rows.len() + m + 1).saturating_mul(n) > MAX_POINTS {
            return Err(Error::invalid(
                "profiles",
                format!(
                    "the smooth loft would have more than {MAX_POINTS} points; use fewer or simpler profiles"
                ),
            ));
        }
        rows.push(sections[s].ring.clone());
        of.push(s);
        for j in 1..m {
            let t = j as f64 / m as f64;
            rows.push(curves.iter().map(|b| bezier_at(b, t)).collect());
            of.push(s);
        }
    }
    if wrap.is_none() {
        rows.push(sections[count - 1].ring.clone());
        of.push(count - 1);
    }
    Ok((rows, of))
}

/// The mesh of a closed solid from its sections: ruled sides from each ring to the next and flat caps on the first and
/// last (see [`build_rows`]).
pub(crate) fn build(sections: &[Section], size: f64) -> Result<TriMesh> {
    let rows: Vec<Vec<V3>> = sections.iter().map(|s| s.ring.clone()).collect();
    let spans: Vec<usize> = (0..sections.len()).collect();
    build_rows(
        &rows,
        &spans,
        true,
        None,
        Some((&sections[0], &sections[sections.len() - 1])),
        size,
    )
}

/// The mesh: one vertex per row point, two triangles per quad between neighboring rows, and with `caps` the first and
/// last rows (whose sections those are) clipped flat in their planes. Rows are closed rings when `ring_closed`, else
/// open chains; with `wrap` the last row joins the first, its point `i` to the first's `i + wrap`. A side quad that is
/// flat is a plane face; the other quads of one span (`spans` gives each row's) are one face with no known surface.
/// Every row winds counterclockwise about the way the rows go from it, so the triangles face out.
#[allow(
    clippy::cast_possible_truncation,
    reason = "ring and row counts are capped far below 2^32"
)]
pub(crate) fn build_rows(
    rows: &[Vec<V3>],
    spans: &[usize],
    ring_closed: bool,
    wrap: Option<usize>,
    caps: Option<(&Section, &Section)>,
    size: f64,
) -> Result<TriMesh> {
    let n = rows[0].len();
    let r = rows.len();
    let mut m = TriMesh::default();
    let mut faces = Faces::default();
    for row in rows {
        m.positions.extend_from_slice(row);
    }
    let at = |k: usize, i: usize| (k * n + i % n) as u32;
    let flat_tol = size * 1e-9;
    let strips = if wrap.is_some() { r } else { r - 1 };
    let quads = if ring_closed { n } else { n - 1 };
    let mut other: Vec<Option<u32>> = vec![None; spans.iter().max().map_or(1, |s| s + 1)];
    for k in 0..strips {
        let (next, shift) = if k + 1 < r {
            (k + 1, 0)
        } else {
            (0, wrap.unwrap_or(0))
        };
        for i in 0..quads {
            let (a0, a1, b0, b1) = (
                at(k, i),
                at(k, i + 1),
                at(next, i + shift),
                at(next, i + 1 + shift),
            );
            let quad = [a0, a1, b1, b0].map(|v| m.positions[v as usize]);
            let id = match quad_plane(quad, flat_tol) {
                Some(s) => faces.push(s),
                None => *other[spans[k]].get_or_insert_with(|| faces.push(Surface::Other)),
            };
            m.triangles.push([a0, a1, b1]);
            m.triangles.push([a0, b1, b0]);
            faces.ids.extend([id, id]);
        }
    }
    if let Some((first, last)) = caps {
        for (k, s, outward) in [(0, first, -1.0), (r - 1, last, 1.0)] {
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
    use std::f64::consts::PI;

    /// No side curve of the landmarked hull bends tighter than this, mm; matched by point count alone, the same stations
    /// pinch to about 19 mm where the bilge changes size.
    const RAIL_FLOOR_MM: f64 = 30.0;

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
            open: false,
            landmarks: Vec::new(),
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
            open: false,
            landmarks: Vec::new(),
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
            open: false,
            landmarks: Vec::new(),
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
            open: false,
            landmarks: Vec::new(),
        };
        assert!(
            err(&[two, at(5.0, square([0.0, 0.0], 5.0))])
                .contains("profile 1: a loft profile is one closed loop, not 2")
        );
        let holed = Profile {
            frame: None,
            loops: vec![square([0.0, 0.0], 10.0), square([0.0, 0.0], 4.0)],
            open: false,
            landmarks: Vec::new(),
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
            open: false,
            landmarks: Vec::new(),
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
        let r = resample(&[[0.0, 0.0], [10.0, 0.0], [10.0, 1.0], [0.0, 1.0]], 26, true);
        assert_eq!(r.len(), 26);
        for c in [[0.0, 0.0], [10.0, 0.0], [10.0, 1.0], [0.0, 1.0]] {
            assert!(r.contains(&c), "{c:?}");
        }
        // the long sides get ten more points each, the short ones one
        assert_eq!(r.iter().filter(|p| p[1] == 0.0).count(), 12);
    }

    /// A hull half-section on the plane across x: the centerline from the deck down to the keel, a flat bottom, a
    /// round bilge of radius `r` flattened to about four sides per millimeter of radius, and a straight side up to the
    /// sheer. Its landmarks are the deck center, keel, both bilge ends, the waterline and the sheer.
    pub(crate) fn station(x: f64, b: f64, d: f64, r: f64, marked: bool) -> Profile {
        let mut pts = vec![[0.0, 0.0], [0.0, -d], [b - r, -d]];
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "small counts"
        )]
        let segs = (4.0 * r).ceil().max(2.0) as usize;
        for j in 1..segs {
            let a = -PI / 2.0 + PI / 2.0 * j as f64 / segs as f64;
            pts.push([b - r + r * a.m_cos(), -d + r + r * a.m_sin()]);
        }
        pts.extend([[b, -d + r], [b, 0.0]]);
        Profile {
            frame: Some(FaceFrame {
                origin: [x, 0.0, 0.0],
                normal: [1.0, 0.0, 0.0],
                u: [0.0, 1.0, 0.0],
                v: [0.0, 0.0, 1.0],
            }),
            loops: vec![Loop {
                points: pts,
                ..Loop::default()
            }],
            open: false,
            landmarks: if marked {
                vec![
                    [0.0, 0.0],
                    [0.0, -d],
                    [b - r, -d],
                    [b, -d + r],
                    [b, -0.4 * d],
                    [b, 0.0],
                ]
            } else {
                Vec::new()
            },
        }
    }

    pub(crate) fn hull(marked: bool) -> Vec<Profile> {
        [
            (0.0, 3.0, 6.0, 1.0),
            (20.0, 8.0, 8.0, 3.0),
            (40.0, 12.0, 9.0, 5.0),
            (60.0, 12.0, 9.0, 5.0),
            (80.0, 7.0, 7.0, 2.5),
        ]
        .iter()
        .map(|&(x, b, d, r)| station(x, b, d, r, marked))
        .collect()
    }

    /// The smallest radius any side curve (one ring point's path through the rows) bends at.
    fn tightest_rail(m: &TriMesh) -> f64 {
        let n = m.positions.iter().take_while(|p| p[0].abs() < 1e-9).count();
        let rows = m.positions.len() / n;
        let mut least = f64::INFINITY;
        for i in 0..n {
            for k in 1..rows - 1 {
                let (a, b, c) = (
                    m.positions[(k - 1) * n + i],
                    m.positions[k * n + i],
                    m.positions[(k + 1) * n + i],
                );
                let (ab, bc, ca) = (vec3::sub(b, a), vec3::sub(c, b), vec3::sub(a, c));
                let cross = vec3::len(vec3::cross(ab, bc));
                if cross > 1e-12 {
                    least = least.min(vec3::len(ab) * vec3::len(bc) * vec3::len(ca) / (2.0 * cross));
                }
            }
        }
        least
    }

    #[test]
    fn neighboring_spans_leave_a_shared_point_the_same_way() {
        let p: [V3; 5] = [
            [0.0, 0.0, 0.0],
            [3.0, 1.0, 10.0],
            [8.0, 0.0, 14.0],
            [2.0, -2.0, 30.0],
            [0.0, 0.0, 33.0],
        ];
        let a = span(p[0], p[1], p[2], p[3]);
        let b = span(p[1], p[2], p[3], p[4]);
        let into = vec3::normalize(vec3::sub(a[3], a[2])).unwrap();
        let out = vec3::normalize(vec3::sub(b[1], b[0])).unwrap();
        assert!(vec3::len(vec3::sub(into, out)) < 1e-12, "{into:?} {out:?}");
        for q in [bezier_at(&a, 1.0), bezier_at(&b, 0.0)] {
            assert!(vec3::len(vec3::sub(q, p[2])) < 1e-12, "{q:?}");
        }
    }

    #[test]
    fn landmarked_stations_do_not_pinch() {
        let opts = Options {
            smooth: true,
            ..Options::default()
        };
        let marked = loft_with(&hull(true), &opts).unwrap();
        closed(&marked);
        let loose = loft_with(&hull(false), &opts).unwrap();
        let (rm, rl) = (tightest_rail(&marked), tightest_rail(&loose));
        eprintln!("tightest rail: landmarked {rm:.3} mm, by point count {rl:.3} mm");
        assert!(rm > RAIL_FLOOR_MM, "{rm} {rl}");
        assert!(
            rl < RAIL_FLOOR_MM,
            "the floor no longer tells the two apart: {rm} {rl}"
        );
    }

    #[test]
    fn landmarks_say_what_is_wrong() {
        let opts = Options::default();
        let err = |p: &[Profile]| loft_with(p, &opts).unwrap_err().to_string();
        let mut h = hull(true);
        h[2].landmarks.pop();
        assert_eq!(
            err(&h),
            "profiles: profile 3 marks 5 landmarks and profile 1 marks 6; every profile marks the same landmarks"
        );
        let mut h = hull(true);
        h[1].landmarks[3] = [50.0, 50.0];
        assert_eq!(
            err(&h),
            "profiles: profile 2: landmark 4 at (50.000, 50.000) is not on the profile"
        );
        let mut h = hull(true);
        h[1].landmarks.swap(2, 4);
        assert_eq!(
            err(&h),
            "profiles: profile 2: its landmarks are not in order around it"
        );
        let mut h = hull(true);
        h[3].landmarks[1..].reverse();
        assert!(err(&h).contains("profile 4's landmarks run around the other way from profile 1's"));
    }

    #[test]
    fn a_span_through_repeated_points_stays_finite() {
        let (a, b) = ([0.0, 0.0, 0.0], [5.0, 1.0, 10.0]);
        for sp in [span(b, a, b, [9.0, 0.0, 20.0]), span(a, b, [3.0, 3.0, 12.0], b)] {
            for t in [0.0, 0.25, 0.5, 1.0] {
                assert!(bezier_at(&sp, t).iter().all(|c| c.is_finite()), "{sp:?}");
            }
        }
    }

    /// Each landmark's point index in each ring.
    fn marks_at(rings: &[Vec<V2>], profiles: &[Profile]) -> Vec<Vec<usize>> {
        rings
            .iter()
            .zip(profiles)
            .map(|(r, p)| {
                p.landmarks
                    .iter()
                    .map(|l| {
                        r.iter()
                            .position(|q| (q[0] - l[0]).m_hypot(q[1] - l[1]) < 1e-9)
                            .unwrap_or_else(|| panic!("{l:?} is not a point of {r:?}"))
                    })
                    .collect()
            })
            .collect()
    }

    fn rings_of(profiles: &[Profile], open: bool) -> Result<Vec<Vec<V2>>> {
        let rings: Vec<(Frame, Vec<V2>)> = profiles
            .iter()
            .enumerate()
            .map(|(k, p)| (frame_of(p).unwrap(), ring_of(k, p).unwrap()))
            .collect();
        let centers: Vec<V3> = profiles.iter().map(|p| frame_of(p).unwrap().origin).collect();
        let facing = vec![[0.0, 0.0, 1.0]; profiles.len()];
        by_landmarks(profiles, &rings, open, &facing, &centers)
    }

    #[test]
    fn landmarks_land_on_the_same_point_of_every_ring() {
        let h = hull(true);
        let rings = rings_of(&h, false).unwrap();
        let at = marks_at(&rings, &h);
        assert!(at.iter().all(|a| *a == at[0]), "{at:?}");
        assert_eq!(at[0][0], 0, "a closed ring starts at its first landmark");
        assert!(rings.iter().all(|r| r.len() == rings[0].len()));
        // listed the other way around, every ring runs the other way, its first landmark still first
        let mut back = hull(true);
        for p in &mut back {
            p.landmarks[1..].reverse();
        }
        let rings = rings_of(&back, false).unwrap();
        let at = marks_at(&rings, &back);
        assert!(at.iter().all(|a| *a == at[0]) && at[0][0] == 0, "{at:?}");
        assert!(poly2d::signed_area(&rings[0]) < 0.0);
        // a loft of them is the same solid
        let opts = Options::default();
        let (a, b) = (
            loft_with(&hull(true), &opts).unwrap(),
            loft_with(&back, &opts).unwrap(),
        );
        closed(&b);
        assert!((a.volume() - b.volume()).abs() < 1e-6 * a.volume());
    }

    fn chain(z: f64, pts: Vec<V2>, marks: Vec<V2>) -> Profile {
        let mut frame = FaceFrame::bed([0.0, 0.0]);
        frame.origin[2] = z;
        Profile {
            frame: Some(frame),
            loops: vec![Loop {
                points: pts,
                ..Loop::default()
            }],
            open: true,
            landmarks: marks,
        }
    }

    #[test]
    fn open_chains_split_at_their_landmarks() {
        // a short and a long chain, each marked once and twice inside its ends
        let short = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]];
        let long = vec![
            [0.0, 0.0],
            [4.0, 0.0],
            [8.0, 0.0],
            [12.0, 0.0],
            [12.0, 4.0],
            [12.0, 8.0],
            [12.0, 12.0],
        ];
        for (ms, ml) in [
            (vec![[10.0, 0.0]], vec![[12.0, 0.0]]),
            (vec![[5.0, 0.0], [10.0, 0.0]], vec![[8.0, 0.0], [12.0, 0.0]]),
        ] {
            let p = [chain(0.0, short.clone(), ms), chain(10.0, long.clone(), ml)];
            let rings = rings_of(&p, true).unwrap();
            let at = marks_at(&rings, &p);
            assert_eq!(at[0], at[1]);
            assert_eq!(rings[0].len(), rings[1].len());
            let near = |a: V2, b: V2| (a[0] - b[0]).m_hypot(a[1] - b[1]) < 1e-12;
            assert!(near(rings[0][0], [0.0, 0.0]) && near(*rings[1].last().unwrap(), [12.0, 12.0]));
            // the runs are spread evenly: equal steps between the landmarks
            let step = |r: &[V2], i: usize| (r[i + 1][0] - r[i][0]).m_hypot(r[i + 1][1] - r[i][1]);
            let last = *at[0].last().unwrap();
            for i in last..rings[0].len() - 2 {
                assert!((step(&rings[1], i) - step(&rings[1], i + 1)).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn landmarks_that_cannot_be_matched_are_refused() {
        let sq = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let closed_at = |z: f64, marks: Vec<V2>| {
            let mut p = chain(z, sq.clone(), marks);
            p.open = false;
            p
        };
        let err = |p: &[Profile]| loft_with(p, &Options::default()).unwrap_err().to_string();
        assert_eq!(
            err(&[
                closed_at(0.0, vec![[0.0, 0.0], [0.0, 0.0]]),
                closed_at(10.0, vec![[0.0, 0.0], [10.0, 10.0]])
            ]),
            "profiles: profile 1: its landmarks are not in order around it"
        );
        // one run takes all of the first ring's points and the other all of the second's
        let dense = |a: V2, b: V2| -> Vec<V2> {
            (0..3000)
                .map(|i| {
                    let t = f64::from(i) / 3000.0;
                    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
                })
                .collect()
        };
        let mut one = dense([0.0, 0.0], [10.0, 0.0]);
        one.extend([[10.0, 10.0], [0.0, 10.0]]);
        let mut two = vec![[0.0, 0.0]];
        two.extend(dense([10.0, 0.0], [10.0, 10.0]));
        two.push([0.0, 10.0]);
        let marks = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]];
        let mut a = closed_at(0.0, marks.clone());
        a.loops[0].points = one;
        let mut b = closed_at(10.0, marks);
        b.loops[0].points = two;
        assert_eq!(
            err(&[a, b]),
            "profiles: the landmarked profiles would have more than 4096 points each"
        );
        let mut many = closed_at(0.0, vec![[0.0, 0.0]; 65]);
        many.landmarks = vec![[0.0, 0.0]; 65];
        let mut other = closed_at(10.0, Vec::new());
        other.landmarks = vec![[0.0, 0.0]; 65];
        assert_eq!(
            err(&[many, other]),
            "profiles: a profile marks at most 64 landmarks"
        );
        // 64 spread around the square, every 0.625 mm, loft
        let marks: Vec<V2> = (0..64)
            .map(|i| {
                let d = f64::from(i) * 40.0 / 64.0;
                if d < 10.0 {
                    [d, 0.0]
                } else if d < 20.0 {
                    [10.0, d - 10.0]
                } else if d < 30.0 {
                    [30.0 - d, 10.0]
                } else {
                    [0.0, 40.0 - d]
                }
            })
            .collect();
        let m = loft_with(
            &[closed_at(0.0, marks.clone()), closed_at(10.0, marks)],
            &Options::default(),
        )
        .unwrap();
        closed(&m);
        assert!((m.volume() - 1000.0).abs() < 1e-6, "{}", m.volume());
    }
}
