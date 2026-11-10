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
/// How near a path's points must be to one cylinder or cone for it to wind about that axis, mm.
const AXIS_TOL_MM: f64 = 0.01;
/// The fewest points that pin a path to an axis: one more than a quadric takes.
const AXIS_MIN_POINTS: usize = 10;

/// The path of a sweep: one open chain of lines, arcs and splines drawn on a plane (the bed when `frame` is absent), or an
/// open polyline of points in space, taken as a smooth curve through them when `smooth`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Path {
    pub frame: Option<FaceFrame>,
    pub loops: Vec<Loop>,
    pub points: Vec<V3>,
    pub smooth: bool,
}

/// The smallest end scale, against the start.
pub const MIN_SCALE: f64 = 0.05;

/// The profile's size at the end of the path against its start: one number for both ways, or one along each of its u
/// and v.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Scale {
    Even(f64),
    Each([f64; 2]),
}

impl Default for Scale {
    fn default() -> Self {
        Self::Even(1.0)
    }
}

impl Scale {
    fn uv(self) -> [f64; 2] {
        match self {
            Self::Even(s) => [s, s],
            Self::Each(s) => s,
        }
    }
}

/// How the change runs from the start of the path to its end.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ease {
    /// in step with the length along the path
    #[default]
    Linear,
    /// slow at both ends and quickest halfway
    Smooth,
}

/// How the profile changes along the path, by length from its start: scaled about its own origin to `scale_end` at
/// the end, and turned `twist_deg` about the path (counterclockwise looking back along it).
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Law {
    pub scale_end: Scale,
    pub twist_deg: f64,
    pub ease: Ease,
}

impl Law {
    fn check(&self) -> Result<()> {
        let [su, sv] = self.scale_end.uv();
        if let Some(s) = [su, sv].into_iter().find(|s| !s.is_finite() || *s < MIN_SCALE) {
            return Err(Error::invalid(
                "scaleEnd",
                format!("the end scale must be {MIN_SCALE} or more of the start, not {s}"),
            ));
        }
        if !self.twist_deg.is_finite() {
            return Err(Error::invalid("twistDeg", "must be a number"));
        }
        Ok(())
    }

    #[allow(
        clippy::float_cmp,
        reason = "only the exact defaults leave the sweep as it was"
    )]
    fn plain(&self) -> bool {
        self.scale_end.uv() == [1.0, 1.0] && self.twist_deg == 0.0
    }

    /// The scale along u and v and the turn in radians at fraction `f` of the path's length.
    fn at(&self, f: f64) -> ([f64; 2], f64) {
        let e = match self.ease {
            Ease::Linear => f,
            Ease::Smooth => f * f * (3.0 - 2.0 * f),
        };
        let [su, sv] = self.scale_end.uv();
        (
            [1.0 + (su - 1.0) * e, 1.0 + (sv - 1.0) * e],
            self.twist_deg.to_radians() * e,
        )
    }

    /// `offs` (from the path point) scaled about the profile's origin `fo` along `fu` and `fv`, then turned about the
    /// path's direction `t`, as they are at fraction `f`.
    fn shape(&self, offs: &[V3], f: f64, fo: V3, (fu, fv): (V3, V3), t: V3) -> Vec<V3> {
        let ([su, sv], a) = self.at(f);
        let (s, c) = a.m_sin_cos();
        offs.iter()
            .map(|&o| {
                let d = vec3::sub(o, fo);
                let o = vec3::add(
                    o,
                    vec3::add(
                        vec3::scale(fu, (su - 1.0) * vec3::dot(d, fu)),
                        vec3::scale(fv, (sv - 1.0) * vec3::dot(d, fv)),
                    ),
                );
                vec3::add(
                    vec3::add(vec3::scale(o, c), vec3::scale(vec3::cross(t, o), s)),
                    vec3::scale(t, vec3::dot(t, o) * (1.0 - c)),
                )
            })
            .collect()
    }

    /// The farthest a profile point within `reach` of the profile's origin, with the path `off` from that origin,
    /// strays from the straight side between fractions `a` and `b`: the 2 by 2 maps of the law, bounded by their size.
    /// Quarter points too, since the smooth ease meets the straight side halfway.
    fn stray(&self, a: f64, b: f64, reach: f64, off: f64) -> f64 {
        let map = |f: f64| {
            let ([su, sv], t) = self.at(f);
            let (s, c) = t.m_sin_cos();
            ([c * su, -s * sv, s * su, c * sv], [c, -s, s, c])
        };
        let ((m0, r0), (m1, r1)) = (map(a), map(b));
        let size = |x: [f64; 4], y: [f64; 4], z: [f64; 4], q: f64| {
            (0..4)
                .map(|i| (z[i] - (1.0 - q) * x[i] - q * y[i]).m_powi(2))
                .sum::<f64>()
                .sqrt()
        };
        [0.25, 0.5, 0.75]
            .into_iter()
            .map(|q| {
                let (mq, rq) = map(a + (b - a) * q);
                size(m0, m1, mq, q) * reach + size(r0, r1, rq, q) * off
            })
            .fold(0.0, f64::max)
    }

    /// The path with points added along its pieces until the sides follow the law within the arc tolerance, and the
    /// piece of the given path each point starts. At most `most` points.
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "step counts are capped far below 2^52"
    )]
    fn refine(&self, pts: &[V3], reach: f64, off: f64, most: usize) -> Result<(Vec<V3>, Vec<usize>)> {
        if self.plain() {
            return Ok((pts.to_vec(), (0..pts.len()).collect()));
        }
        let at = fractions(pts);
        let too_many = || {
            Error::invalid(
                "twistDeg",
                format!(
                    "the twist and scale need more than {most} points along the path; use less twist or a simpler profile"
                ),
            )
        };
        let mut counts = Vec::with_capacity(pts.len() - 1);
        let mut total = 1usize;
        for k in 0..pts.len() - 1 {
            let (a, b) = (at[k], at[k + 1]);
            let mut n = 1usize;
            loop {
                let step = (b - a) / n as f64;
                let worst = (0..n)
                    .map(|j| self.stray(a + step * j as f64, a + step * (j + 1) as f64, reach, off))
                    .fold(0.0f64, f64::max);
                if worst <= sketch_loft::SMOOTH_TOL_MM {
                    break;
                }
                // the stray falls with the square of the step
                n = ((n as f64 * (worst / sketch_loft::SMOOTH_TOL_MM).sqrt()).ceil() as usize).max(n + 1);
                if total + n > most {
                    return Err(too_many());
                }
            }
            total += n;
            if total > most {
                return Err(too_many());
            }
            counts.push(n);
        }
        let mut out = Vec::with_capacity(total);
        let mut of = Vec::with_capacity(total);
        for (k, &n) in counts.iter().enumerate() {
            for j in 0..n {
                out.push(vec3::lerp(pts[k], pts[k + 1], j as f64 / n as f64));
                of.push(k);
            }
        }
        out.push(pts[pts.len() - 1]);
        of.push(pts.len() - 1);
        Ok((out, of))
    }
}

/// Each point's length along the polyline as a fraction of the whole, 0 to 1.
fn fractions(pts: &[V3]) -> Vec<f64> {
    let mut at = Vec::with_capacity(pts.len());
    let mut run = 0.0;
    at.push(0.0);
    for w in pts.windows(2) {
        run += vec3::len(vec3::sub(w[1], w[0]));
        at.push(run);
    }
    let whole = run.max(f64::MIN_POSITIVE);
    for a in &mut at {
        *a /= whole;
    }
    if let Some(l) = at.last_mut() {
        *l = 1.0;
    }
    at
}

/// The solid swept from `profile` along `path`: the profile keeps its place and turn relative to the path, with ruled
/// sides between path points and flat caps. A path of points that winds one way about a fixed axis (a helix, or any
/// path on one cylinder or cone about it) turns the profile about that axis with the path, so a helix sweep comes back
/// to itself each turn. Any other path carries it in a rotation minimizing frame, so it does not twist about the path,
/// and at each corner the sides meet on the plane halfway between the two directions: a path of straight lines sweeps
/// exact prisms and a flattened arc follows the arc. The profile does not need to touch the path; it is carried as it
/// sits relative to the path's start.
pub fn sweep(profile: &Profile, path: &Path) -> Result<TriMesh> {
    sweep_with(profile, path, None, &Law::default())
}

/// The sweep, with the profile scaled and turned along the path by `law`, and its sides made a shell `thicken` thick
/// and no caps when that is given. An open profile makes a surface, so it needs `thicken`.
#[allow(
    clippy::too_many_lines,
    reason = "one pass from the profile and path to the mesh"
)]
pub fn sweep_with(profile: &Profile, path: &Path, thicken: Option<&Thicken>, law: &Law) -> Result<TriMesh> {
    if profile.open && thicken.is_none() {
        return Err(Error::invalid(
            "thicken",
            "an open profile makes a surface; give thicken to make it a solid",
        ));
    }
    law.check()?;
    let (pts, t_start, t_end) = path_points(path)?;
    // only a path of points leaves its plane; the given points, before smoothing or steps cut them
    let axis = if path.points.is_empty() {
        None
    } else {
        axis_of(&path.points)
    };
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
    let reach = flat.iter().fold(0.0f64, |r, p| r.max(p[0].m_hypot(p[1])));
    let off = {
        let d = vec3::sub(pts[0], frame.origin);
        vec3::len(vec3::sub(d, vec3::scale(frame.w, vec3::dot(d, frame.w))))
    };
    let (pts, of) = law.refine(&pts, reach, off, MAX_POINTS / flat.len().max(1))?;
    if flat.len().saturating_mul(pts.len()) > MAX_POINTS {
        return Err(Error::invalid(
            "path",
            format!(
                "the sweep would have more than {MAX_POINTS} points; use a shorter path, fewer arcs or a simpler profile"
            ),
        ));
    }
    let m = pts.len();
    let at = fractions(&pts);
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
    let [su, sv] = law.scale_end.uv();
    let size = flat
        .iter()
        .map(|&p| frame.at(p, 0.0))
        .chain(pts.iter().copied())
        .fold(0.0f64, |s, p| s.max(p[0].abs()).max(p[1].abs()).max(p[2].abs()))
        .max(1.0)
        * su.max(sv).max(1.0);
    let eps = size * 1e-9;

    // Each profile point and the profile's axes, from the path's start, carried along the path. A flattened arc's first
    // chord leaves at half a chord's turn from the arc itself, so they turn by that first; the side lines then meet the
    // profile's plane in a copy of it stretched by at most the arc's own flattening tolerance. Each ring takes the law
    // on the carried points before they go onto its plane.
    let carry = |flat: &[V2]| -> Result<(Vec<Vec<V3>>, Frame)> {
        if let Some((on, dir)) = axis {
            return about_axis(flat, &frame, &pts, &at, law, (on, dir), facing, tangents[m - 2]);
        }
        let lead = |v: V3| turned(v, t_start, tangents[0]);
        let mut offs: Vec<V3> = flat
            .iter()
            .map(|&p| lead(vec3::sub(frame.at(p, 0.0), pts[0])))
            .collect();
        let (mut fo, mut fu, mut fv, mut fw) = (
            lead(vec3::sub(frame.origin, pts[0])),
            lead(frame.u),
            lead(frame.v),
            lead(frame.w),
        );
        let mut rings: Vec<Vec<V3>> = Vec::with_capacity(m);
        let first = law.shape(&offs, 0.0, fo, (fu, fv), tangents[0]);
        rings.push(onto(&first, pts[0], tangents[0], frame.origin, frame.w));
        for k in 1..m - 1 {
            let (t0, t1) = (tangents[k - 1], tangents[k]);
            // the miter plane between the two directions; `path_points` refused a path that doubles back
            let nm = vec3::normalize(vec3::add(t0, t1)).unwrap_or(t0);
            let den = vec3::dot(t0, nm);
            rings.push(
                law.shape(&offs, at[k], fo, (fu, fv), t0)
                    .into_iter()
                    .map(|o| {
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
        let end = Frame {
            origin: vec3::add(pts[m - 1], tail(fo)),
            u: tail(fu),
            v: tail(fv),
            w: tail(fw),
        };
        across(last, end.w, facing)?;
        let shaped = law.shape(&offs, 1.0, fo, (fu, fv), last);
        rings.push(onto(&shaped, pts[m - 1], last, end.origin, end.w));
        Ok((rings, end))
    };
    let (mut rings, mut end) = carry(&flat)?;
    if !law.plain()
        && let Some(finer) = split_bowed(&flat, &rings, !profile.open, MAX_POINTS / m)?
    {
        flat = finer;
        (rings, end) = carry(&flat)?;
    }

    sides_forward(&rings, &pts, &tangents, eps, law.scale_end != Scale::default())?;

    if let Some(t) = thicken {
        let surface = sketch_loft::build_rows(&rings, &of, !profile.open, None, None, size)?;
        return thicken::thicken(&surface, t);
    }
    // the end cap is the section as the law leaves it, in its own plane
    let end_flat = if law.plain() {
        flat.clone()
    } else {
        rings[m - 1]
            .iter()
            .map(|&p| {
                let d = vec3::sub(p, end.origin);
                [vec3::dot(d, end.u), vec3::dot(d, end.v)]
            })
            .collect()
    };
    let start = Section {
        center: sketch_loft::centroid(&rings[0]),
        ring: rings[0].clone(),
        flat,
        frame,
    };
    let finish = Section {
        center: sketch_loft::centroid(&rings[m - 1]),
        ring: rings[m - 1].clone(),
        flat: end_flat,
        frame: end,
    };
    let mesh = sketch_loft::build_rows(&rings, &of, true, None, Some((&start, &finish)), size)?;
    if boolean::Solid::new(&mesh).is_ok_and(|s| s.self_intersects()) {
        return Err(Error::geometry(
            "sweep",
            "the swept body runs into itself where the path comes back near itself; move those parts of the path further apart or use a smaller profile",
        ));
    }
    Ok(mesh)
}

/// The rings and end frame of a sweep about the axis through `on` along `dir`: each ring is the profile, with the law
/// taken as at the start, turned about the axis as far as its path point and carried to it. Nothing is transported,
/// so a helix comes back to itself each turn.
#[allow(clippy::too_many_arguments, reason = "the sweep's own pieces")]
fn about_axis(
    flat: &[V2],
    frame: &Frame,
    pts: &[V3],
    at: &[f64],
    law: &Law,
    (on, dir): (V3, V3),
    facing: f64,
    last: V3,
) -> Result<(Vec<Vec<V3>>, Frame)> {
    let offs: Vec<V3> = flat
        .iter()
        .map(|&p| vec3::sub(frame.at(p, 0.0), pts[0]))
        .collect();
    let fo = vec3::sub(frame.origin, pts[0]);
    // the twist turns the profile in its own plane, about its normal the way the path goes
    let along = vec3::scale(frame.w, facing.signum());
    let mut rings = Vec::with_capacity(pts.len());
    let (mut angle, mut was) = (0.0, vec3::sub(pts[0], on));
    let mut turn = |k: usize| {
        let r = vec3::sub(pts[k], on);
        angle += vec3::dot(vec3::cross(was, r), dir)
            .m_atan2(vec3::dot(was, r) - vec3::dot(was, dir) * vec3::dot(r, dir));
        was = r;
        angle
    };
    for k in 0..pts.len() {
        let a = turn(k);
        rings.push(
            law.shape(&offs, at[k], fo, (frame.u, frame.v), along)
                .into_iter()
                .map(|o| vec3::add(pts[k], spun(o, dir, a)))
                .collect(),
        );
    }
    let a = angle;
    let end = Frame {
        origin: vec3::add(pts[pts.len() - 1], spun(fo, dir, a)),
        u: spun(frame.u, dir, a),
        v: spun(frame.v, dir, a),
        w: spun(frame.w, dir, a),
    };
    across(last, end.w, facing)?;
    Ok((rings, end))
}

/// `v` turned by `a` radians about the unit direction `k`.
fn spun(v: V3, k: V3, a: f64) -> V3 {
    let (s, c) = a.m_sin_cos();
    vec3::add(
        vec3::add(vec3::scale(v, c), vec3::scale(vec3::cross(k, v), s)),
        vec3::scale(k, vec3::dot(k, v) * (1.0 - c)),
    )
}

/// The axis (a point on it and its unit direction) that a path of points winds about, or None when it does not: its
/// points lie within `AXIS_TOL_MM` of one cylinder or cone, go one way round the axis and do not lie on one plane.
/// The axis is the best fit of a cylinder, else a cone, from two guesses; the points are then checked against it.
#[allow(
    clippy::cast_precision_loss,
    clippy::too_many_lines,
    reason = "point counts are capped far below 2^52; one fit and its check"
)]
fn axis_of(given: &[V3]) -> Option<(V3, V3)> {
    let n = given.len();
    if n < AXIS_MIN_POINTS {
        return None;
    }
    // centered and scaled to about 1, so the quadric's terms weigh alike
    let mid = vec3::scale(
        given.iter().fold([0.0; 3], |s, &p| vec3::add(s, p)),
        1.0 / n as f64,
    );
    let size = given
        .iter()
        .fold(0.0f64, |s, &p| s.max(vec3::len(vec3::sub(p, mid))));
    if size <= AXIS_TOL_MM {
        return None;
    }
    let q: Vec<V3> = given
        .iter()
        .map(|&p| vec3::scale(vec3::sub(p, mid), 1.0 / size))
        .collect();
    // a flat path keeps the rotation minimizing frame, which does not turn on a plane
    let mut cov = [[0.0; 3]; 3];
    for p in &q {
        for (i, row) in cov.iter_mut().enumerate() {
            for (j, c) in row.iter_mut().enumerate() {
                *c += p[i] * p[j];
            }
        }
    }
    let (val, vec) = eigen(cov);
    let low = (0..3).fold(0, |b, i| if val[i] < val[b] { i } else { b });
    let normal = [vec[0][low], vec[1][low], vec[2][low]];
    if q.iter()
        .all(|&p| vec3::dot(p, normal).abs() * size <= AXIS_TOL_MM)
    {
        return None;
    }
    // a first guess at the axis from the quadric through the points; a short arc leaves it loose, so it is refined
    let mut big = [[0.0; 10]; 10];
    for p in &q {
        let [x, y, z] = *p;
        let row = [x * x, y * y, z * z, x * y, y * z, z * x, x, y, z, 1.0];
        for (i, line) in big.iter_mut().enumerate() {
            for (j, c) in line.iter_mut().enumerate() {
                *c += row[i] * row[j];
            }
        }
    }
    let (val, vec) = eigen(big);
    let low = (0..10).fold(0, |b, i| if val[i] < val[b] { i } else { b });
    let c: [f64; 10] = std::array::from_fn(|i| vec[i][low]);
    let quad = [
        [c[0], c[3] / 2.0, c[5] / 2.0],
        [c[3] / 2.0, c[1], c[4] / 2.0],
        [c[5] / 2.0, c[4] / 2.0, c[2]],
    ];
    // a quadric of revolution has two equal eigenvalues; the axis is the third's vector
    let (val, vec) = eigen(quad);
    let mut order = [0, 1, 2];
    order.sort_by(|&i, &j| val[i].total_cmp(&val[j]));
    let [l0, l1, l2] = order.map(|i| val[i]);
    let one = if l1 - l0 < l2 - l1 { order[2] } else { order[0] };
    // and a second from the way the path bends, which leans to the axis as it winds round it
    let bend = q.windows(3).fold([0.0; 3], |s, w| {
        vec3::add(s, vec3::cross(vec3::sub(w[1], w[0]), vec3::sub(w[2], w[1])))
    });
    // the fit runs on at most 256 of the points; the check below takes them all
    let every = n.div_ceil(256);
    let few: Vec<V3> = q
        .iter()
        .step_by(every)
        .copied()
        .chain(q.last().copied())
        .collect();
    let starts = [
        Some([vec[0][one], vec[1][one], vec[2][one]]),
        vec3::normalize(bend),
    ];
    // a cylinder first, since a cone can lean to fit a short arc of one; then a cone
    [false, true].into_iter().find_map(|cone| {
        let (_, dir, at) = starts
            .into_iter()
            .flatten()
            .filter_map(|d| refined(&few, d, cone))
            .min_by(|a, b| a.0.total_cmp(&b.0))?;
        winds_about(given, vec3::add(mid, vec3::scale(at, size)), dir)
    })
}

/// The axis through `on` along `dir` when the points wind about it: their distance from it runs straight with the
/// height along it within `AXIS_TOL_MM`, none is on it, and they go one way round.
#[allow(
    clippy::cast_precision_loss,
    reason = "point counts are capped far below 2^52"
)]
fn winds_about(given: &[V3], on: V3, dir: V3) -> Option<(V3, V3)> {
    let n = given.len();
    let polar: Vec<(f64, f64, V3)> = given
        .iter()
        .map(|&p| {
            let d = vec3::sub(p, on);
            let h = vec3::dot(d, dir);
            let r = vec3::sub(d, vec3::scale(dir, h));
            (h, vec3::len(r), r)
        })
        .collect();
    let (sh, sr) = polar.iter().fold((0.0, 0.0), |(a, b), &(h, r, _)| (a + h, b + r));
    let (hm, rm) = (sh / n as f64, sr / n as f64);
    let (shh, shr) = polar.iter().fold((0.0, 0.0), |(a, b), &(h, r, _)| {
        (a + (h - hm) * (h - hm), b + (h - hm) * (r - rm))
    });
    let slope = if shh > 0.0 { shr / shh } else { 0.0 };
    let off = polar
        .iter()
        .fold(0.0f64, |w, &(h, r, _)| w.max((r - rm - slope * (h - hm)).abs()));
    if off > AXIS_TOL_MM || polar.iter().any(|&(_, r, _)| r <= 10.0 * AXIS_TOL_MM) {
        return None;
    }
    let way: Vec<f64> = polar
        .windows(2)
        .map(|w| vec3::dot(vec3::cross(w[0].2, w[1].2), dir))
        .collect();
    let one_way = way.iter().all(|&s| s > 0.0) || way.iter().all(|&s| s < 0.0);
    one_way.then_some((on, dir))
}

/// The axis direction near `start` that the points `q` lie round most nearly, by a pattern search over directions: the
/// fit's squared residual, the direction and a point on the axis.
fn refined(q: &[V3], start: V3, cone: bool) -> Option<(f64, V3, V3)> {
    let (mut best, mut at) = round_about(q, start, cone)?;
    let (mut dir, mut step) = (start, 0.05);
    for _ in 0..4000 {
        if step < 1e-10 {
            break;
        }
        let e1 = vec3::any_perpendicular(dir);
        let e2 = vec3::cross(dir, e1);
        let tried = [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)]
            .into_iter()
            .find_map(|(a, b)| {
                let d = vec3::normalize(vec3::add(
                    dir,
                    vec3::add(vec3::scale(e1, a * step), vec3::scale(e2, b * step)),
                ))?;
                let (r, c) = round_about(q, d, cone)?;
                (r < best).then_some((r, d, c))
            });
        match tried {
            Some((r, d, c)) => (best, dir, at) = (r, d, c),
            None => step /= 2.0,
        }
    }
    Some((best, dir, at))
}

/// The cylinder (or with `cone`, the cone) about direction `dir` nearest the points `q`, by least squares across the
/// axis (x^2 + y^2 = 2 cx x + 2 cy y + k0, plus k1 z + k2 z^2 for a cone): its squared residual and the point where the
/// axis crosses the plane through the origin.
#[allow(clippy::many_single_char_names, reason = "the fit's own terms")]
fn round_about(q: &[V3], dir: V3, cone: bool) -> Option<(f64, V3)> {
    let used = if cone { 5 } else { 3 };
    let u = vec3::any_perpendicular(dir);
    let v = vec3::cross(dir, u);
    let terms = |p: V3| {
        let (x, y, z) = (vec3::dot(p, u), vec3::dot(p, v), vec3::dot(p, dir));
        ([2.0 * x, 2.0 * y, 1.0, z, z * z], x * x + y * y)
    };
    let mut m = [[0.0; 6]; 5];
    for &p in q {
        let (row, t) = terms(p);
        for (i, line) in m.iter_mut().enumerate().take(used) {
            for (j, c) in line.iter_mut().take(used).enumerate() {
                *c += row[i] * row[j];
            }
            line[5] += row[i] * t;
        }
    }
    // the terms a cylinder leaves out solve to 0
    for (i, line) in m.iter_mut().enumerate().skip(used) {
        line[i] = 1.0;
    }
    let k = solved(m)?;
    let r = q
        .iter()
        .map(|&p| {
            let (row, t) = terms(p);
            (t - (0..5).map(|i| row[i] * k[i]).sum::<f64>()).m_powi(2)
        })
        .sum();
    Some((r, vec3::add(vec3::scale(u, k[0]), vec3::scale(v, k[1]))))
}

/// The solution of a 5 by 5 system given as rows with the right hand side last, by elimination with the largest
/// pivot, or None when it is singular.
#[allow(clippy::needless_range_loop, reason = "elimination reads two rows at once")]
fn solved(mut m: [[f64; 6]; 5]) -> Option<[f64; 5]> {
    let scale = m
        .iter()
        .fold(0.0f64, |s, r| r.iter().take(5).fold(s, |s, c| s.max(c.abs())));
    for col in 0..5 {
        let piv = (col..5).max_by(|&a, &b| m[a][col].abs().total_cmp(&m[b][col].abs()))?;
        if m[piv][col].abs() <= 1e-14 * scale {
            return None;
        }
        m.swap(col, piv);
        for r in col + 1..5 {
            let f = m[r][col] / m[col][col];
            for c in col..6 {
                m[r][c] -= f * m[col][c];
            }
        }
    }
    let mut x = [0.0; 5];
    for r in (0..5).rev() {
        let s: f64 = (r + 1..5).map(|c| m[r][c] * x[c]).sum();
        x[r] = (m[r][5] - s) / m[r][r];
    }
    Some(x)
}

/// The eigenvalues and unit eigenvectors (as columns) of a symmetric matrix, by cyclic Jacobi.
#[allow(
    clippy::needless_range_loop,
    reason = "a rotation reads two rows or columns at once"
)]
fn eigen<const N: usize>(mut a: [[f64; N]; N]) -> ([f64; N], [[f64; N]; N]) {
    let mut v = [[0.0; N]; N];
    for (i, row) in v.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    for _ in 0..64 {
        let off: f64 = (0..N)
            .map(|i| (i + 1..N).map(|j| a[i][j] * a[i][j]).sum::<f64>())
            .sum();
        let diag: f64 = (0..N).map(|i| a[i][i] * a[i][i]).sum();
        if off <= 1e-30 * diag.max(f64::MIN_POSITIVE) {
            break;
        }
        for p in 0..N {
            for q in p + 1..N {
                if a[p][q].abs() < f64::MIN_POSITIVE {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..N {
                    let (x, y) = (a[k][p], a[k][q]);
                    (a[k][p], a[k][q]) = (c * x - s * y, s * x + c * y);
                }
                for k in 0..N {
                    let (x, y) = (a[p][k], a[q][k]);
                    (a[p][k], a[q][k]) = (c * x - s * y, s * x + c * y);
                }
                for row in &mut v {
                    let (x, y) = (row[p], row[q]);
                    (row[p], row[q]) = (c * x - s * y, s * x + c * y);
                }
            }
        }
    }
    (std::array::from_fn(|i| a[i][i]), v)
}

/// The profile with points added along each edge whose side quads bow out of their plane by more than the arc
/// tolerance (a turned or unevenly scaled side does), or None when none do. A quad bows by a quarter of the skew of its
/// corners across its plane, which grows with the edge's length.
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "cut counts are capped far below 2^52"
)]
fn split_bowed(flat: &[V2], rings: &[Vec<V3>], closed: bool, most: usize) -> Result<Option<Vec<V2>>> {
    let n = flat.len();
    let edges = if closed { n } else { n - 1 };
    let mut cuts = vec![1usize; edges];
    for (j, c) in cuts.iter_mut().enumerate() {
        let i = (j + 1) % n;
        let bow = rings
            .windows(2)
            .map(|w| {
                let (a0, a1, b0, b1) = (w[0][j], w[0][i], w[1][j], w[1][i]);
                let skew = vec3::sub(vec3::add(a0, b1), vec3::add(a1, b0));
                vec3::normalize(vec3::cross(vec3::sub(b1, a0), vec3::sub(b0, a1)))
                    .map_or(0.0, |nn| vec3::dot(skew, nn).abs() / 4.0)
            })
            .fold(0.0f64, f64::max);
        *c = (bow / sketch_loft::SMOOTH_TOL_MM).ceil().clamp(1.0, most as f64) as usize;
    }
    if cuts.iter().all(|&c| c == 1) {
        return Ok(None);
    }
    let total = n + cuts.iter().map(|c| c - 1).sum::<usize>();
    if total > most {
        return Err(Error::invalid(
            "twistDeg",
            format!(
                "the twist and scale need more than {most} points around the profile; use less twist or a simpler profile"
            ),
        ));
    }
    let mut out = Vec::with_capacity(total);
    for (j, &p) in flat.iter().enumerate() {
        out.push(p);
        if let Some(&c) = cuts.get(j) {
            let q = flat[(j + 1) % n];
            out.extend((1..c).map(|s| {
                let t = s as f64 / c as f64;
                [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
            }));
        }
    }
    Ok(Some(out))
}

/// Fails when a side line runs back along its piece of the path between two rings: the sides would cross there.
fn sides_forward(rings: &[Vec<V3>], pts: &[V3], tangents: &[V3], eps: f64, scaled: bool) -> Result<()> {
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
                    "the path bends too tightly for the profile near ({:.2}, {:.2}, {:.2}) mm, so the sides would cross; use a wider bend or a smaller profile{}",
                    at[0],
                    at[1],
                    at[2],
                    if scaled { " or end scale" } else { "" }
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
            if path.smooth {
                if path.points.len() > MAX_PATH {
                    return Err(Error::invalid(
                        "path",
                        format!("a smooth path takes at most {MAX_PATH} points"),
                    ));
                }
                apart(&path.points)?;
                let (pts, start, end) = smooth(&path.points)?;
                ends = Some((start, end));
                pts
            } else {
                path.points.clone()
            }
        }
        ([_], true) if path.smooth => {
            return Err(Error::invalid(
                "path",
                "smooth is for a path of points; draw a spline for a smooth path on a plane",
            ));
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
    apart(&pts)?;
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

/// Fails when a point is on the point before it.
fn apart(pts: &[V3]) -> Result<()> {
    match (1..pts.len()).find(|&i| vec3::len(vec3::sub(pts[i], pts[i - 1])) < MIN_STEP_MM) {
        Some(i) => Err(Error::invalid(
            "path",
            format!("point {} is on the point before it", i + 1),
        )),
        None => Ok(()),
    }
}

/// The centripetal Catmull-Rom curve through `pts` as the loft's smooth sides draw it, its ends mirroring their
/// neighbors, flattened within the arc tolerance, and the directions it starts and ends in.
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "step counts are capped far below 2^52"
)]
fn smooth(pts: &[V3]) -> Result<(Vec<V3>, V3, V3)> {
    let m = pts.len();
    if m < 2 {
        return Err(Error::invalid("path", "a sweep path needs 2 or more points"));
    }
    let mirror = |a: V3, b: V3| vec3::sub(vec3::scale(a, 2.0), b);
    let at = |k: usize, back: bool| -> V3 {
        match (k, back) {
            (0, true) => mirror(pts[0], pts[1]),
            (k, true) => pts[k - 1],
            (k, false) if k + 2 < m => pts[k + 2],
            _ => mirror(pts[m - 1], pts[m - 2]),
        }
    };
    let mut out = Vec::new();
    let (mut start, mut end) = ([0.0; 3], [0.0; 3]);
    for k in 0..m - 1 {
        let b = sketch_loft::span(at(k, true), pts[k], pts[k + 1], at(k, false));
        let n = sketch_loft::steps(&b);
        if n > MAX_PATH as f64 {
            return Err(Error::invalid(
                "path",
                format!(
                    "the smooth path bends too sharply near point {}; space its points more evenly",
                    k + 1
                ),
            ));
        }
        let n = n as usize;
        out.extend((0..n).map(|j| sketch_loft::bezier_at(&b, j as f64 / n as f64)));
        if k == 0 {
            start = vec3::sub(b[1], b[0]);
        }
        end = vec3::sub(b[3], b[2]);
    }
    out.push(pts[m - 1]);
    let chord = |a: V3, b: V3| vec3::normalize(vec3::sub(b, a)).unwrap_or([0.0, 0.0, 1.0]);
    let start = vec3::normalize(start).unwrap_or_else(|| chord(pts[0], pts[1]));
    let end = vec3::normalize(end).unwrap_or_else(|| chord(pts[m - 2], pts[m - 1]));
    Ok((out, start, end))
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
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a few steps per span"
    )]
    fn a_smooth_path_stays_on_its_curve() {
        let given = [
            [0.0, 0.0, 0.0],
            [0.0, 4.0, 20.0],
            [12.0, 10.0, 34.0],
            [30.0, 10.0, 40.0],
            [40.0, 0.0, 41.0],
        ];
        let (pts, start, end) = smooth(&given).unwrap();
        // it passes through every given point
        for g in given {
            assert!(pts.iter().any(|&p| vec3::len(vec3::sub(p, g)) < 1e-12), "{g:?}");
        }
        // every chord stays within the arc tolerance of the curve between its ends
        let mirror = |a: V3, b: V3| vec3::sub(vec3::scale(a, 2.0), b);
        let mut i = 0;
        for k in 0..given.len() - 1 {
            let p0 = if k == 0 {
                mirror(given[0], given[1])
            } else {
                given[k - 1]
            };
            let p3 = if k + 2 < given.len() {
                given[k + 2]
            } else {
                mirror(given[4], given[3])
            };
            let b = sketch_loft::span(p0, given[k], given[k + 1], p3);
            let n = sketch_loft::steps(&b) as usize;
            for j in 0..n {
                let mid = sketch_loft::bezier_at(&b, (j as f64 + 0.5) / n as f64);
                let chord = vec3::lerp(pts[i + j], pts[i + j + 1], 0.5);
                assert!(
                    vec3::len(vec3::sub(mid, chord)) <= sketch_loft::SMOOTH_TOL_MM,
                    "span {k} step {j}"
                );
            }
            i += n;
        }
        assert_eq!(i + 1, pts.len());
        // with mirrored ends the curve leaves along its first chord and arrives along its last
        let chord = |a: V3, b: V3| vec3::normalize(vec3::sub(b, a)).unwrap();
        assert!(
            vec3::len(vec3::sub(start, chord(given[0], given[1]))) < 1e-9,
            "{start:?}"
        );
        assert!(
            vec3::len(vec3::sub(end, chord(given[3], given[4]))) < 1e-9,
            "{end:?}"
        );
    }

    #[test]
    fn the_law_adds_steps_only_where_it_changes_the_sides() {
        let up = points(&[[0.0, 0.0, 0.0], [0.0, 0.0, 30.0]]);
        let taper = Law {
            scale_end: Scale::Even(0.5),
            ..Law::default()
        };
        // a linear taper on a straight piece is ruled already
        let m = sweep_with(&bed(square([0.0, 0.0], 10.0)), &up, None, &taper).unwrap();
        assert_eq!(m.positions.len(), 8);
        // eased or twisted, the piece is cut into steps
        let eased = Law {
            ease: Ease::Smooth,
            ..taper
        };
        assert!(
            sweep_with(&bed(square([0.0, 0.0], 10.0)), &up, None, &eased)
                .unwrap()
                .positions
                .len()
                > 8
        );
        let end = |m: &TriMesh| -> Vec<V3> {
            m.positions
                .iter()
                .copied()
                .filter(|p| (p[2] - 30.0).abs() < 1e-9)
                .collect()
        };
        // a quarter turn counterclockwise looking back along the path, and the corners scaled to [0.5, 2]
        let law = Law {
            scale_end: Scale::Each([0.5, 2.0]),
            twist_deg: 90.0,
            ease: Ease::Linear,
        };
        let m = sweep_with(&bed(square([0.0, 0.0], 10.0)), &up, None, &law).unwrap();
        closed(&m);
        let mut top = end(&m);
        top.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
        // (5, 5) scales to (2.5, 10), then turns to (-10, 2.5)
        assert!(
            top.iter()
                .any(|p| (p[0] + 10.0).abs() < 1e-9 && (p[1] - 2.5).abs() < 1e-9),
            "{top:?}"
        );
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

    /// `turns` turns of a right hand helix about z through the origin, `per` points a turn.
    #[allow(clippy::cast_precision_loss, reason = "a few hundred points")]
    fn helix(r: f64, pitch: f64, turns: usize, per: usize) -> Vec<V3> {
        (0..=turns * per)
            .map(|i| {
                let t = 2.0 * PI * i as f64 / per as f64;
                let (s, c) = t.m_sin_cos();
                [r * c, r * s, pitch * t / (2.0 * PI)]
            })
            .collect()
    }

    /// A thread tooth on the axial plane at radius `r`: 3.5 wide at the root, 2.1 tall, 60 degree flanks.
    fn tooth(r: f64) -> Profile {
        let f = FaceFrame::for_normal([r, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap();
        on(
            f,
            Loop {
                points: vec![[0.0, -1.75], [2.1, -0.5375], [2.1, 0.5375], [0.0, 1.75]],
                ..Loop::default()
            },
        )
    }

    /// The roll of ring `k` (root to crest against the radial way, in degrees) and the tilt of its plane out of the
    /// axial plane, read from the mesh. Rings are `n` points; the two nearest the axis are the root.
    fn roll_and_tilt(m: &TriMesh, n: usize, k: usize, at: V3) -> (f64, f64) {
        let ring = &m.positions[k * n..(k + 1) * n];
        let radial = |p: V3| p[0].m_hypot(p[1]);
        let mut by: Vec<V3> = ring.to_vec();
        by.sort_by(|a, b| radial(*a).total_cmp(&radial(*b)));
        let mid = |a: V3, b: V3| vec3::scale(vec3::add(a, b), 0.5);
        let d = vec3::sub(mid(by[2], by[3]), mid(by[0], by[1]));
        let er = vec3::normalize([at[0], at[1], 0.0]).unwrap();
        let roll = vec3::dot(d, [0.0, 0.0, 1.0])
            .m_atan2(vec3::dot(d, er))
            .to_degrees();
        let mut nn = [0.0; 3];
        for i in 0..n {
            nn = vec3::add(nn, vec3::cross(ring[i], ring[(i + 1) % n]));
        }
        let et = [-er[1], er[0], 0.0];
        let tilt = vec3::dot(vec3::normalize(nn).unwrap(), et)
            .abs()
            .min(1.0)
            .m_acos()
            .to_degrees();
        (roll, tilt)
    }

    #[test]
    fn a_helix_sweep_comes_back_to_itself_each_turn() {
        // the profile keeps its angle to the helix's axis: no roll about the path, no tilt out of the axial plane
        for (pitch, turns, per) in [(4.0, 5, 48), (4.0, 5, 400), (20.0, 3, 48), (20.0, 3, 72)] {
            let pts = helix(35.0, pitch, turns, per);
            let m = sweep(&tooth(35.0), &points(&pts)).unwrap();
            closed(&m);
            for turn in 1..=turns {
                let (roll, tilt) = roll_and_tilt(&m, 4, turn * per, pts[turn * per]);
                assert!(
                    roll.abs() < 0.05,
                    "pitch {pitch} at {per} a turn: roll {roll} at turn {turn}"
                );
                assert!(
                    tilt < 0.05,
                    "pitch {pitch} at {per} a turn: tilt {tilt} at turn {turn}"
                );
            }
        }
    }

    /// The mesh's size and sums over its corners, to pin a sweep to what it was.
    #[allow(clippy::cast_precision_loss, reason = "counts are small")]
    fn print_of(m: &TriMesh) -> [f64; 6] {
        let mut f = [
            m.positions.len() as f64,
            m.triangles.len() as f64,
            0.0,
            0.0,
            0.0,
            0.0,
        ];
        for p in &m.positions {
            f[2] += p[0];
            f[3] += p[1];
            f[4] += p[2];
            f[5] += p[0] * p[1] + p[1] * p[2] + p[2] * p[0];
        }
        f
    }

    #[test]
    #[allow(clippy::unreadable_literal, reason = "the sums as the sweep printed them")]
    fn other_paths_keep_the_frame_they_had() {
        // a flat arc, a flat s bend, a smooth curve in space and a polyline in space sweep as they did before
        let r = 3.0;
        let flat = FaceFrame::for_normal([20.0, 0.0, 0.0], [0.0, 1.0, 0.0]).unwrap();
        let arc_path = chain([20.0, 0.0], vec![arc([0.0, 0.0], 120.0)]);
        let s_path = chain([20.0, 0.0], vec![arc([0.0, 0.0], 90.0), arc([0.0, 40.0], -90.0)]);
        let space = [
            [0.0, 0.0, 0.0],
            [10.0, 6.0, 12.0],
            [22.0, -6.0, 20.0],
            [30.0, 4.0, 34.0],
            [44.0, 0.0, 40.0],
        ];
        let leaves = vec3::normalize(vec3::sub(space[1], space[0])).unwrap();
        let tilted = FaceFrame::for_normal([0.0, 0.0, 0.0], leaves).unwrap();
        let curve = Path {
            points: space.to_vec(),
            smooth: true,
            ..Path::default()
        };
        let cases = [
            sweep(&on(flat, circle([0.0, 0.0], 2.0 * r)), &arc_path).unwrap(),
            sweep(&on(flat, square([0.0, 0.0], 4.0)), &s_path).unwrap(),
            sweep(&on(tilted, circle([0.0, 0.0], 2.0 * r)), &curve).unwrap(),
            sweep(&on(tilted, square([0.0, 0.0], 4.0)), &points(&space)).unwrap(),
        ];
        // from the sweep before the helix frame
        let was = [
            [
                2744.0,
                5484.0,
                22506.054119394597,
                38981.62921268628,
                6.997049181565228e-13,
                189652.73912062356,
            ],
            [
                292.0,
                580.0,
                3.979039320256561e-13,
                5840.000000000002,
                0.0,
                -37913.953320301625,
            ],
            [
                7896.0,
                15788.0,
                163471.62326801222,
                6909.8089869642145,
                168735.32569914495,
                4699384.602534944,
            ],
            [20.0, 36.0, 424.0, 16.000000000000004, 424.0, 13867.968212479322],
        ];
        for (k, (m, w)) in cases.iter().zip(was).enumerate() {
            closed(m);
            let f = print_of(m);
            for (a, b) in f.iter().zip(w) {
                assert!(
                    (a - b).abs() <= 1e-9 * b.abs().max(1.0),
                    "case {k}: {f:?} vs {w:?}"
                );
            }
        }
    }

    #[test]
    #[ignore = "timing, run with --release --ignored"]
    fn timing_of_a_helix_sweep() {
        for per in [48, 400] {
            let pts = helix(35.0, 4.0, 5, per);
            let mut best = f64::MAX;
            for _ in 0..7 {
                let t0 = std::time::Instant::now();
                let m = sweep(&tooth(35.0), &points(&pts)).unwrap();
                best = best.min(t0.elapsed().as_secs_f64());
                assert!(!m.triangles.is_empty());
            }
            let t0 = std::time::Instant::now();
            assert!(axis_of(&pts).is_some());
            println!(
                "helix 5 turns at {per} a turn: {:.1} ms, finding its axis {:.2} ms",
                best * 1e3,
                t0.elapsed().as_secs_f64() * 1e3
            );
        }
    }

    #[test]
    fn a_helix_or_cone_winds_about_its_axis_and_other_paths_do_not() {
        let near = |got: Option<(V3, V3)>, at: V3, dir: V3| {
            let (on, d) = got.expect("an axis");
            assert!(vec3::len(vec3::cross(d, dir)) < 1e-9, "{d:?}");
            assert!(vec3::len(vec3::cross(vec3::sub(on, at), dir)) < 1e-6, "{on:?}");
        };
        near(axis_of(&helix(35.0, 4.0, 5, 48)), [0.0; 3], [0.0, 0.0, 1.0]);
        near(axis_of(&helix(35.0, 20.0, 1, 12)), [0.0; 3], [0.0, 0.0, 1.0]);
        // a conical spring, and a helix moved and laid along x
        let cone: Vec<V3> = helix(20.0, 5.0, 4, 36)
            .into_iter()
            .map(|p| {
                let k = 1.0 - p[2] / 40.0;
                [p[0] * k, p[1] * k, p[2]]
            })
            .collect();
        near(axis_of(&cone), [0.0; 3], [0.0, 0.0, 1.0]);
        let laid: Vec<V3> = helix(8.0, 3.0, 3, 24)
            .into_iter()
            .map(|p| [p[2] + 5.0, p[0] - 2.0, p[1] + 7.0])
            .collect();
        near(axis_of(&laid), [5.0, -2.0, 7.0], [1.0, 0.0, 0.0]);
        // points typed to two places still wind about it
        let typed: Vec<V3> = helix(35.0, 4.0, 2, 24)
            .into_iter()
            .map(|p| p.map(|c| (c * 100.0).round() / 100.0))
            .collect();
        assert!(axis_of(&typed).is_some());
        // a flat spiral, a flat arc, a curve in space and too few points keep the transported frame
        let flat: Vec<V3> = helix(10.0, 1.0, 2, 24)
            .into_iter()
            .map(|p| [p[0] * (1.0 + p[2]), p[1] * (1.0 + p[2]), 0.0])
            .collect();
        assert!(axis_of(&flat).is_none());
        let arc: Vec<V3> = helix(10.0, 0.0, 1, 24).into_iter().take(20).collect();
        assert!(axis_of(&arc).is_none());
        let space: Vec<V3> = (0..30)
            .map(|i| {
                let t = f64::from(i) / 3.0;
                [t * 4.0, 6.0 * t.m_sin(), 2.0 * t + 0.3 * t * t]
            })
            .collect();
        assert!(axis_of(&space).is_none());
        assert!(axis_of(&helix(35.0, 4.0, 1, 8)).is_none());
    }

    #[test]
    fn twist_and_taper_ride_on_the_helix_frame() {
        let pts = helix(35.0, 4.0, 5, 48);
        let law = Law {
            scale_end: Scale::Even(0.5),
            twist_deg: 90.0,
            ease: Ease::Linear,
        };
        let m = sweep_with(&tooth(35.0), &points(&pts), None, &law).unwrap();
        closed(&m);
        // the tooth halved about its origin and turned a quarter in its own plane, on the axial plane after 5 turns
        for [x, z] in [[0.0, -1.75], [2.1, -0.5375], [2.1, 0.5375], [0.0, 1.75]] {
            let want = [35.0 + 0.5 * z, 0.0, 20.0 - 0.5 * x];
            assert!(
                m.positions.iter().any(|&p| vec3::len(vec3::sub(p, want)) < 1e-9),
                "{want:?}"
            );
        }
    }

    #[test]
    fn a_partial_helix_turns_the_profile_about_its_axis() {
        // a quarter turn rising 5 mm in 12 points, as a handle might: it winds about z, so the end ring is the start
        // ring turned a quarter about z and lifted, not rolled about the path as a transported frame leaves it
        let pts: Vec<V3> = (0..12)
            .map(|i| {
                let t = PI / 2.0 * f64::from(i) / 11.0;
                let (s, c) = t.m_sin_cos();
                [35.0 * c, 35.0 * s, 20.0 * t / (2.0 * PI)]
            })
            .collect();
        let (on, dir) = axis_of(&pts).unwrap();
        assert!(vec3::len(vec3::cross(dir, [0.0, 0.0, 1.0])) < 1e-6, "{dir:?}");
        assert!(on[0].m_hypot(on[1]) < 1e-4, "{on:?}");
        let m = sweep(&tooth(35.0), &points(&pts)).unwrap();
        closed(&m);
        for [x, z] in [[0.0, -1.75], [2.1, -0.5375], [2.1, 0.5375], [0.0, 1.75]] {
            let want = [0.0, 35.0 + x, 5.0 + z];
            let near = m.positions[11 * 4..]
                .iter()
                .map(|&p| vec3::len(vec3::sub(p, want)))
                .fold(f64::MAX, f64::min);
            assert!(near < 1e-6, "{want:?} is {near} mm off");
        }
    }
}
