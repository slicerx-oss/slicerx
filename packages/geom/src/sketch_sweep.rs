// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a solid swept from one sketch profile along an open path: a closed profile and its holes, or an open one thickened
//! into a shell
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
    /// Fraction `f` of the path's length as the ease runs it.
    fn eased(&self, f: f64) -> f64 {
        match self.ease {
            Ease::Linear => f,
            Ease::Smooth => f * f * (3.0 - 2.0 * f),
        }
    }

    fn at(&self, f: f64) -> ([f64; 2], f64) {
        let e = self.eased(f);
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
    /// A point that moves up to `morph` toward the end section moves by the eased fraction of that, then the law's map,
    /// so that is one more map. Quarter points too, since the smooth ease meets the straight side halfway.
    fn stray(&self, a: f64, b: f64, reach: f64, off: f64, morph: f64) -> f64 {
        let map = |f: f64| {
            let ([su, sv], t) = self.at(f);
            let (s, c) = t.m_sin_cos();
            let e = self.eased(f);
            (
                [c * su, -s * sv, s * su, c * sv],
                [c, -s, s, c],
                [e * c * su, -e * s * sv, e * s * su, e * c * sv],
            )
        };
        let ((m0, r0, e0), (m1, r1, e1)) = (map(a), map(b));
        let size = |x: [f64; 4], y: [f64; 4], z: [f64; 4], q: f64| {
            (0..4)
                .map(|i| (z[i] - (1.0 - q) * x[i] - q * y[i]).m_powi(2))
                .sum::<f64>()
                .sqrt()
        };
        [0.25, 0.5, 0.75]
            .into_iter()
            .map(|q| {
                let (mq, rq, eq) = map(a + (b - a) * q);
                size(m0, m1, mq, q) * reach + size(r0, r1, rq, q) * off + size(e0, e1, eq, q) * morph
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
    fn refine(
        &self,
        pts: &[V3],
        reach: f64,
        off: f64,
        morph: f64,
        most: usize,
    ) -> Result<(Vec<V3>, Vec<usize>)> {
        if self.plain() && morph <= 0.0 {
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
                    .map(|j| self.stray(a + step * j as f64, a + step * (j + 1) as f64, reach, off, morph))
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
/// sits relative to the path's start. A hole in the profile runs the length of the sweep as a bore.
pub fn sweep(profile: &Profile, path: &Path) -> Result<TriMesh> {
    sweep_with(profile, path, None, &Law::default())
}

/// The sweep, with the profile scaled and turned along the path by `law`, and its sides made a shell `thicken` thick
/// and no caps when that is given. An open profile makes a surface, so it needs `thicken`.
pub fn sweep_with(profile: &Profile, path: &Path, thicken: Option<&Thicken>, law: &Law) -> Result<TriMesh> {
    sweep_morph(profile, None, path, thicken, law)
}

/// The sweep, with the section turning from `profile` at the start into `to` at the end when that is given: `to` is
/// one loop drawn on the profile's own plane, closed or open as the profile is, and has no frame of its own. The two
/// are matched point to point as a loft matches its profiles (the same count, at the least twist), and each ring is
/// their blend at its fraction along the path, with `law`'s ease, before the law's scale and turn.
#[allow(
    clippy::too_many_lines,
    reason = "one pass from the profile and path to the mesh"
)]
pub fn sweep_morph(
    profile: &Profile,
    to: Option<&Profile>,
    path: &Path,
    thicken: Option<&Thicken>,
    law: &Law,
) -> Result<TriMesh> {
    if profile.open && thicken.is_none() {
        return Err(Error::invalid(
            "thicken",
            "an open profile makes a surface; give thicken to make it a solid",
        ));
    }
    law.check()?;
    #[cfg(test)]
    CLEARED.set(false);
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
    // every loop's points one after another, the outer loop first, and how many each has
    let (mut flat, mut lens) = if profile.open {
        let mut c =
            sketch_loft::open_ring(&profile.loops, "sweep").map_err(|why| Error::invalid("profile", why))?;
        // an open chain winds the way it and the line across its ends go around, as a closed ring does
        if poly2d::signed_area(&c) < 0.0 {
            c.reverse();
        }
        let n = c.len();
        (c, vec![n])
    } else {
        let region =
            sketch_loft::one_region(&profile.loops, "sweep").map_err(|why| Error::invalid("profile", why))?;
        if thicken.is_some() && !region.holes.is_empty() {
            return Err(Error::invalid(
                "thicken",
                "a profile with holes already has its walls; leave thicken out, or thicken a profile without holes",
            ));
        }
        let lens = std::iter::once(&region.outer)
            .chain(&region.holes)
            .map(Vec::len)
            .collect();
        (region.vertices().collect(), lens)
    };
    // the end section, matched to the start point for point
    let mut last_flat = match to {
        Some(e) => {
            if lens.len() > 1 {
                return Err(Error::invalid(
                    "endProfile",
                    "a profile with holes takes no end profile yet; sweep the outside with its end profile, then cut the bore with a sweep of its own",
                ));
            }
            let (f, l) = end_ring(e, profile.open, &flat)?;
            flat = f;
            lens = vec![flat.len()];
            Some(l)
        }
        None => None,
    };
    // the farthest a matched point moves from the start section to the end
    let morph = last_flat.as_ref().map_or(0.0, |l| {
        flat.iter()
            .zip(l)
            .fold(0.0f64, |m, (a, b)| m.max((b[0] - a[0]).m_hypot(b[1] - a[1])))
    });
    let reach = flat
        .iter()
        .chain(last_flat.iter().flatten())
        .fold(0.0f64, |r, p| r.max(p[0].m_hypot(p[1])));
    let off = {
        let d = vec3::sub(pts[0], frame.origin);
        vec3::len(vec3::sub(d, vec3::scale(frame.w, vec3::dot(d, frame.w))))
    };
    let (pts, of) = law.refine(&pts, reach, off, morph, MAX_POINTS / flat.len().max(1))?;
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
    // every ring's outer loop winds counterclockwise about the way the sweep goes, and its holes clockwise
    if facing < 0.0 {
        let mut from = 0;
        for &len in &lens {
            flat[from..from + len].reverse();
            from += len;
        }
        if let Some(l) = &mut last_flat {
            l.reverse();
        }
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
    let carry = |flat: &[V2], last: Option<&[V2]>| -> Result<(Vec<Vec<V3>>, Frame)> {
        if let Some((on, dir)) = axis {
            return about_axis(
                (flat, last),
                &frame,
                &pts,
                &at,
                law,
                (on, dir),
                facing,
                tangents[m - 2],
            );
        }
        let lead = |v: V3| turned(v, t_start, tangents[0]);
        let place = |flat: &[V2]| -> Vec<V3> {
            flat.iter()
                .map(|&p| lead(vec3::sub(frame.at(p, 0.0), pts[0])))
                .collect()
        };
        let mut offs = place(flat);
        let mut ends = last.map(&place);
        // the section at fraction `f`: the start's points moved toward the end's
        let at_f =
            |offs: &[V3], ends: Option<&Vec<V3>>, f: f64| blend(offs, ends.map(Vec::as_slice), law.eased(f));
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
                law.shape(&at_f(&offs, ends.as_ref(), at[k]), at[k], fo, (fu, fv), t0)
                    .into_iter()
                    .map(|o| {
                        let t = -vec3::dot(o, nm) / den;
                        vec3::add(pts[k], vec3::add(o, vec3::scale(t0, t)))
                    })
                    .collect(),
            );
            let turn = |v: V3| turned(v, t0, t1);
            for o in offs.iter_mut().chain(ends.iter_mut().flatten()) {
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
        let shaped = law.shape(&at_f(&offs, ends.as_ref(), 1.0), 1.0, fo, (fu, fv), last);
        rings.push(onto(&shaped, pts[m - 1], last, end.origin, end.w));
        Ok((rings, end))
    };
    let plain = law.plain() && last_flat.is_none();
    let (mut rings, mut end) = carry(&flat, last_flat.as_deref())?;
    // a turn or uneven scale bows the side quads out of their planes; a blend alone keeps each point's side straight
    // between rings, ruled as a loft's sides are
    if !law.plain()
        && let Some(cuts) = bowed(&rings, &lens, !profile.open, MAX_POINTS / m)?
    {
        last_flat = last_flat.map(|l| cut_sides(&l, &lens, &cuts).0);
        (flat, lens) = cut_sides(&flat, &lens, &cuts);
        (rings, end) = carry(&flat, last_flat.as_deref())?;
    }

    sides_forward(&rings, &pts, &tangents, eps, law.scale_end != Scale::default())?;

    if let Some(t) = thicken {
        let surface = sketch_loft::build_rows(&rings, &lens, &of, !profile.open, None, None, size)?;
        return thicken::thicken(&surface, t);
    }
    // the end cap is the section as the law leaves it, in its own plane
    let end_flat = if plain {
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
        lens: lens.clone(),
        frame,
    };
    let finish = Section {
        center: sketch_loft::centroid(&rings[m - 1]),
        ring: rings[m - 1].clone(),
        flat: end_flat,
        lens: lens.clone(),
        frame: end,
    };
    let mesh = sketch_loft::build_rows(&rings, &lens, &of, true, None, Some((&start, &finish)), size)?;
    // a sweep about an axis whose turns are shown apart, and each strip apart from its neighbors, needs no check; a
    // sweep into an end profile always takes the whole check
    let clear = to.is_none() && axis.is_some_and(|a| turns_clear(&mesh, &rings, &lens, a, size));
    #[cfg(test)]
    CLEARED.set(clear);
    if !clear && boolean::Solid::new(&mesh).is_ok_and(|s| s.self_intersects()) {
        return Err(Error::geometry(
            "sweep",
            "the swept body runs into itself where the path comes back near itself; move those parts of the path further apart or use a smaller profile",
        ));
    }
    Ok(mesh)
}

#[cfg(test)]
thread_local! {
    /// Whether the last sweep on this thread left out the whole self-intersection check.
    static CLEARED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The span of a sweep about an axis taken by a ring, the strip between two rings or a cap: its angles about the
/// axis (unwrapped, the way the sweep winds), heights along it and distances from it.
#[derive(Clone, Copy)]
struct Span {
    lo: f64,
    hi: f64,
    h: (f64, f64),
    r: (f64, f64),
}

impl Span {
    fn join(self, o: Self) -> Self {
        Self {
            lo: self.lo.min(o.lo),
            hi: self.hi.max(o.hi),
            h: (self.h.0.min(o.h.0), self.h.1.max(o.h.1)),
            r: (self.r.0.min(o.r.0), self.r.1.max(o.r.1)),
        }
    }

    /// The nearest a point of a triangle or cap with corners in this span comes to the axis: its corners lie less than
    /// half a turn apart about it, so the whole of it lies beyond the line across their middle angle.
    fn near(self) -> f64 {
        self.r.0 * ((self.hi - self.lo) / 2.0).m_cos()
    }

    /// Whether nothing in this span can meet anything in `o`, one or more turns on: they are apart along the axis or
    /// from it.
    fn apart(self, o: Self, gap: f64) -> bool {
        self.h.1 + gap < o.h.0
            || o.h.1 + gap < self.h.0
            || self.r.1 + gap < o.near()
            || o.r.1 + gap < self.near()
    }
}

/// The span of each of `rings` about the axis through `on` along `dir`, its angles counting up the way the rings go
/// round, or None when a ring comes within `gap` of the axis.
fn ring_spans(rings: &[Vec<V3>], (on, dir): (V3, V3), gap: f64) -> Option<Vec<Span>> {
    let polar = |p: V3| {
        let d = vec3::sub(p, on);
        let h = vec3::dot(d, dir);
        let r = vec3::sub(d, vec3::scale(dir, h));
        (h, vec3::len(r), r)
    };
    let turn = |a: V3, b: V3| vec3::dot(vec3::cross(a, b), dir).m_atan2(vec3::dot(a, b));
    // each ring's angles measured from its first point, and that point's angle carried on from ring to ring
    let mut spans: Vec<Span> = Vec::with_capacity(rings.len());
    let mut was: Option<(V3, f64)> = None;
    for ring in rings {
        let (_, _, r0) = polar(ring[0]);
        let at = was.map_or(0.0, |(w, a)| a + turn(w, r0));
        was = Some((r0, at));
        let mut s = Span {
            lo: f64::MAX,
            hi: f64::MIN,
            h: (f64::MAX, f64::MIN),
            r: (f64::MAX, f64::MIN),
        };
        for &p in ring {
            let (h, rho, rv) = polar(p);
            if rho <= gap {
                return None;
            }
            let a = at + turn(r0, rv);
            s = s.join(Span {
                lo: a,
                hi: a,
                h: (h, h),
                r: (rho, rho),
            });
        }
        spans.push(s);
    }
    // the way the sweep winds counts up
    let m = spans.len();
    if spans[m - 1].lo < spans[0].lo {
        for s in &mut spans {
            (s.lo, s.hi) = (-s.hi, -s.lo);
        }
    }
    Some(spans)
}

/// The most of a turn one strip of a sweep about an axis may take for `turns_clear` to decide, radians.
const STRIP_MOST: f64 = std::f64::consts::FRAC_PI_4;

/// Whether `mesh`, a sweep about the axis through `on` along `dir` from `rings` (two side triangles a quad, strip by
/// strip, then the start and end caps), cannot run into itself, so the self-intersection check of the whole can be left
/// out. Each ring is its loops one after another, `lens` points each, the outer loop first and then any holes, and a
/// strip is the side quads of every loop in that order. Each ring's angles about the axis, heights along it and distances from it bound what lies between: a side
/// triangle or cap has its corners within less than half a turn of each other, so it lies in the wedge their angles
/// span, at heights between theirs and no nearer the axis than `Span::near`. Then strips two or more apart within a
/// turn lie in wedges that do not meet, and strips a turn or more apart must be apart along the axis or from it. What
/// is left, each strip or cap and the next, is shown apart triangle by triangle. A hole's points count in its ring's
/// span like the outer loop's, and its wall's triangles are among those shown apart, from the outer wall's, from other
/// holes' and from the caps', so a holed sweep is left unchecked only when its loops are shown clear of each other as
/// well. False when any of it cannot be shown, so the whole is checked as before.
fn turns_clear(mesh: &TriMesh, rings: &[Vec<V3>], lens: &[usize], (on, dir): (V3, V3), size: f64) -> bool {
    let m = rings.len();
    if m < 3 {
        return false;
    }
    let gap = size * 1e-6;
    let Some(spans) = ring_spans(rings, (on, dir), gap) else {
        return false;
    };
    if spans[m - 1].hi - spans[0].lo < 2.0 * std::f64::consts::PI {
        // less than a turn: nothing comes back near, so the whole check is quick
        return false;
    }
    // the start cap, the strips in order, the end cap
    let items: Vec<Span> = std::iter::once(spans[0])
        .chain(spans.windows(2).map(|w| w[0].join(w[1])))
        .chain(std::iter::once(spans[m - 1]))
        .collect();
    if items.iter().any(|s| s.hi - s.lo > STRIP_MOST || s.near() <= gap)
        || items.windows(2).any(|w| w[1].lo < w[0].lo)
    {
        return false;
    }
    // within a turn: everything before an item's neighbor ends before it starts
    let ahead = gap / spans.iter().fold(0.0f64, |r, s| r.max(s.r.1));
    let mut most = f64::MIN;
    for k in 2..items.len() {
        most = most.max(items[k - 2].hi);
        if most + ahead >= items[k].lo {
            return false;
        }
    }
    // a turn or more on: what lies at the same angles is apart
    let wide = items.iter().fold(0.0f64, |w, s| w.max(s.hi - s.lo));
    let full = 2.0 * std::f64::consts::PI;
    for x in &items {
        let mut t = 1.0;
        while x.lo + t * full <= items[items.len() - 1].hi {
            let (lo, hi) = (x.lo + t * full - ahead, x.hi + t * full + ahead);
            let from = items.partition_point(|y| y.lo < lo - wide);
            for y in items[from..].iter().take_while(|y| y.lo <= hi) {
                if y.hi >= lo && !x.apart(*y, gap) {
                    return false;
                }
            }
            t += 1.0;
        }
    }
    neighbors_apart(mesh, rings, lens, size)
}

/// Whether in `mesh`, swept from `rings` of loops `lens` points each (two side triangles a quad, every loop's quads strip
/// by strip, then the start and end caps), each strip or cap and the next meet only where they share corners: every two
/// of their triangles whose boxes meet are shown to, an outer wall's and a hole wall's alike.
fn neighbors_apart(mesh: &TriMesh, rings: &[Vec<V3>], lens: &[usize], size: f64) -> bool {
    let m = rings.len();
    let n = rings[0].len();
    // each loop is a closed ring of its own quads, so a strip is two triangles a ring point whatever the holes
    let strip = 2 * n;
    let tris = &mesh.triangles;
    if lens.iter().sum::<usize>() != n
        || lens.iter().any(|&len| len < 3)
        || rings.iter().any(|r| r.len() != n)
        || tris.len() < (m - 1) * strip
    {
        return false;
    }
    let caps = &tris[(m - 1) * strip..];
    let start: Vec<usize> = (0..caps.len())
        .filter(|&t| caps[t].iter().all(|&v| (v as usize) < n))
        .map(|t| (m - 1) * strip + t)
        .collect();
    let end: Vec<usize> = (0..caps.len())
        .filter(|&t| caps[t].iter().all(|&v| (v as usize) >= (m - 1) * n))
        .map(|t| (m - 1) * strip + t)
        .collect();
    if start.len() + end.len() != caps.len() {
        return false;
    }
    let item = |k: usize, into: &mut Vec<usize>| {
        if k == 0 {
            into.extend(&start);
        } else if k == m {
            into.extend(&end);
        } else {
            into.extend((k - 1) * strip..k * strip);
        }
    };
    let tol = size * 1e-12;
    let boxes: Vec<(V3, V3)> = tris
        .iter()
        .map(|t| {
            let p = t.map(|v| mesh.positions[v as usize]);
            (
                [0, 1, 2].map(|k| p[0][k].min(p[1][k]).min(p[2][k]) - tol),
                [0, 1, 2].map(|k| p[0][k].max(p[1][k]).max(p[2][k]) + tol),
            )
        })
        .collect();
    let mut both = Vec::with_capacity(2 * strip);
    (0..m).all(|k| {
        both.clear();
        item(k, &mut both);
        item(k + 1, &mut both);
        pairs_apart(&mesh.positions, tris, &boxes, &mut both, tol)
    })
}

/// Whether every two of the triangles `which` of `tris` whose `boxes` (grown by `tol`) meet, meet at most where they
/// share corners, shown by `corners_apart`. The boxes are swept along x.
fn pairs_apart(at: &[V3], tris: &[[u32; 3]], boxes: &[(V3, V3)], which: &mut [usize], tol: f64) -> bool {
    which.sort_by(|&a, &b| boxes[a].0[0].total_cmp(&boxes[b].0[0]));
    for (k, &ta) in which.iter().enumerate() {
        let (alo, ahi) = boxes[ta];
        for &tb in &which[k + 1..] {
            let (blo, bhi) = boxes[tb];
            if blo[0] > ahi[0] {
                break;
            }
            if ta == tb || (1..3).any(|i| blo[i] > ahi[i] || alo[i] > bhi[i]) {
                continue;
            }
            if !corners_apart(at, tris[ta], tris[tb], tol) {
                return false;
            }
        }
    }
    true
}

/// Whether triangles `a` and `b` (corner indices into `at`) meet at most at the corners they share: a plane through a
/// shared corner or edge, or any plane when they share none, has one wholly on each side. Every side is judged with
/// room for rounding, `tol` for each unit of the plane's normal, so a pair that cannot be shown apart is never taken
/// as apart.
fn corners_apart(at: &[V3], a: [u32; 3], b: [u32; 3], tol: f64) -> bool {
    let mut both = [0u32; 3];
    let mut count = 0;
    for &v in &a {
        if b.contains(&v) {
            both[count] = v;
            count += 1;
        }
    }
    let (pa, pb) = (a.map(|v| at[v as usize]), b.map(|v| at[v as usize]));
    match count {
        0 => axis_apart(pa, pb, tol),
        1 => corner_apart((a, pa), (b, pb), both[0], at[both[0] as usize], tol),
        2 => edge_apart(
            (a, pa),
            (b, pb),
            [both[0], both[1]].map(|v| at[v as usize]),
            &both[..2],
            tol,
        ),
        _ => false,
    }
}

fn unit(v: V3) -> V3 {
    vec3::normalize(v).unwrap_or([0.0; 3])
}

fn normal_of(p: [V3; 3]) -> V3 {
    unit(vec3::cross(vec3::sub(p[1], p[0]), vec3::sub(p[2], p[0])))
}

/// Two triangles with no corner in common, apart along one of the axes of the separating axis test.
fn axis_apart(pa: [V3; 3], pb: [V3; 3], tol: f64) -> bool {
    let (na, nb) = (normal_of(pa), normal_of(pb));
    let ea = [0, 1, 2].map(|k| vec3::sub(pa[(k + 1) % 3], pa[k]));
    let eb = [0, 1, 2].map(|k| vec3::sub(pb[(k + 1) % 3], pb[k]));
    let mut axes = [na, nb]
        .into_iter()
        .chain(ea.iter().map(|&e| vec3::cross(na, e)))
        .chain(eb.iter().map(|&f| vec3::cross(nb, f)))
        .chain(
            ea.iter()
                .flat_map(|&e| eb.iter().map(move |&f| vec3::cross(e, f))),
        );
    axes.any(|n| {
        let room = tol * vec3::len(n);
        let span = |p: [V3; 3]| {
            p.iter()
                .map(|&q| vec3::dot(n, q))
                .fold((f64::MAX, f64::MIN), |(lo, hi), d| (lo.min(d), hi.max(d)))
        };
        let ((alo, ahi), (blo, bhi)) = (span(pa), span(pb));
        room > 0.0 && (ahi + 2.0 * room < blo || bhi + 2.0 * room < alo)
    })
}

/// Two triangles sharing only corner `v` at `o`: a plane through `o` holds the rest of `a` on its plus side and the
/// rest of `b` on its minus side. The planes tried lean a little off either triangle's own, or stand across the
/// surface the two lie on along one of their edges from `o`.
fn corner_apart((a, pa): ([u32; 3], [V3; 3]), (b, pb): ([u32; 3], [V3; 3]), v: u32, o: V3, tol: f64) -> bool {
    let splits = |n: V3| {
        let room = tol * vec3::len(n);
        let side = |t: [u32; 3], p: [V3; 3]| {
            t.into_iter()
                .zip(p)
                .filter(move |(w, _)| *w != v)
                .map(move |(_, q)| vec3::dot(n, vec3::sub(q, o)))
        };
        room > 0.0 && side(a, pa).all(|d| d > room) && side(b, pb).all(|d| d < -room)
    };
    let toward = |p: [V3; 3], t: [u32; 3]| {
        unit(
            t.iter()
                .zip(p)
                .filter(|(w, _)| **w != v)
                .fold([0.0; 3], |s, (_, q)| vec3::add(s, unit(vec3::sub(q, o)))),
        )
    };
    let (na, nb) = (normal_of(pa), normal_of(pb));
    let (sa, sb) = (toward(pa, a), toward(pb, b));
    let up = unit(vec3::add(na, nb));
    let lean = 1e-6;
    let neg = |n: V3| vec3::scale(n, -1.0);
    let leaning = [na, neg(na)]
        .map(|n| vec3::add(n, vec3::scale(sa, lean)))
        .into_iter()
        .chain([nb, neg(nb)].map(|n| vec3::sub(n, vec3::scale(sb, lean))));
    let across = [(a, pa, sa), (b, pb, neg(sb))].into_iter().flat_map(|(t, p, s)| {
        t.into_iter()
            .zip(p)
            .filter(|(w, _)| *w != v)
            .flat_map(move |(_, q)| {
                let c = unit(vec3::cross(up, vec3::sub(q, o)));
                [c, neg(c)].map(|n| vec3::add(n, vec3::scale(s, lean)))
            })
    });
    std::iter::once(vec3::sub(sa, sb))
        .chain(leaning)
        .chain(across)
        .any(splits)
}

/// Two triangles sharing edge `[u, w]` (corners `shared`): the plane through the edge halfway between them has the
/// third corner of each on its own side. The plane is meant to hold the edge; both corners are held further off by the
/// most it can lean along the edge, so the plane that holds the edge exactly splits them as well.
fn edge_apart(
    (a, pa): ([u32; 3], [V3; 3]),
    (b, pb): ([u32; 3], [V3; 3]),
    [u, w]: [V3; 2],
    shared: &[u32],
    tol: f64,
) -> bool {
    let e = unit(vec3::sub(w, u));
    let third = |t: [u32; 3], p: [V3; 3]| {
        t.into_iter()
            .zip(p)
            .find(|(v, _)| !shared.contains(v))
            .map(|(_, q)| q)
    };
    let (Some(qa), Some(qb)) = (third(a, pa), third(b, pb)) else {
        return false;
    };
    let off = |q: V3| {
        let d = vec3::sub(q, u);
        unit(vec3::sub(d, vec3::scale(e, vec3::dot(d, e))))
    };
    let n = vec3::sub(off(qa), off(qb));
    let room = tol * vec3::len(n);
    let len = vec3::len(vec3::sub(w, u));
    if room <= 0.0 || len <= 0.0 {
        return false;
    }
    let reach = vec3::len(vec3::sub(qa, u)).max(vec3::len(vec3::sub(qb, u)));
    let extra = vec3::dot(n, vec3::sub(w, u)).abs() / len * reach;
    vec3::dot(n, vec3::sub(qa, u)) > room + extra && vec3::dot(n, vec3::sub(qb, u)) < -(room + extra)
}

/// The rings and end frame of a sweep about the axis through `on` along `dir`: each ring is the profile, with the law
/// taken as at the start, turned about the axis as far as its path point and carried to it. Nothing is transported,
/// so a helix comes back to itself each turn.
#[allow(clippy::too_many_arguments, reason = "the sweep's own pieces")]
fn about_axis(
    (flat, to): (&[V2], Option<&[V2]>),
    frame: &Frame,
    pts: &[V3],
    at: &[f64],
    law: &Law,
    (on, dir): (V3, V3),
    facing: f64,
    last: V3,
) -> Result<(Vec<Vec<V3>>, Frame)> {
    let place = |flat: &[V2]| -> Vec<V3> {
        flat.iter()
            .map(|&p| vec3::sub(frame.at(p, 0.0), pts[0]))
            .collect()
    };
    let offs = place(flat);
    let ends = to.map(&place);
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
            law.shape(
                &blend(&offs, ends.as_deref(), law.eased(at[k])),
                at[k],
                fo,
                (frame.u, frame.v),
                along,
            )
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

/// How many pieces each side of each loop needs, the same on every ring, so its quads stay within the arc tolerance of
/// the curved side the law makes between two rings (a turned or unevenly scaled side bows out of its plane by a quarter
/// of the skew of its corners across it, which grows with the side's length); None when every side is fine as one
/// piece. The loops are `lens` points each, one after another, and a `closed` loop has a side from its last point
/// back to its first.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the count is clamped to the point budget"
)]
fn bowed(rings: &[Vec<V3>], lens: &[usize], closed: bool, most: usize) -> Result<Option<Vec<Vec<usize>>>> {
    let mut cuts: Vec<Vec<usize>> = Vec::with_capacity(lens.len());
    let mut from = 0;
    for &len in lens {
        let edges = if closed { len } else { len - 1 };
        cuts.push(
            (0..edges)
                .map(|e| {
                    let (j, i) = (from + e, from + (e + 1) % len);
                    let bow = rings
                        .windows(2)
                        .map(|w| {
                            let (a0, a1, b0, b1) = (w[0][j], w[0][i], w[1][j], w[1][i]);
                            let skew = vec3::sub(vec3::add(a0, b1), vec3::add(a1, b0));
                            vec3::normalize(vec3::cross(vec3::sub(b1, a0), vec3::sub(b0, a1)))
                                .map_or(0.0, |nn| vec3::dot(skew, nn).abs() / 4.0)
                        })
                        .fold(0.0f64, f64::max);
                    (bow / sketch_loft::SMOOTH_TOL_MM).ceil().clamp(1.0, most as f64) as usize
                })
                .collect(),
        );
        from += len;
    }
    if cuts.iter().flatten().all(|&c| c == 1) {
        return Ok(None);
    }
    let total = lens.iter().sum::<usize>() + cuts.iter().flatten().map(|c| c - 1).sum::<usize>();
    if total > most {
        return Err(Error::invalid(
            "twistDeg",
            format!(
                "the twist and scale need more than {most} points around the profile; use less twist or a simpler profile"
            ),
        ));
    }
    Ok(Some(cuts))
}

/// `flat`, loops of `lens` points one after another, with each side cut into the pieces `cuts` gives it, and each
/// loop's new point count.
#[allow(clippy::cast_precision_loss, reason = "cut counts are small")]
fn cut_sides(flat: &[V2], lens: &[usize], cuts: &[Vec<usize>]) -> (Vec<V2>, Vec<usize>) {
    let mut out = Vec::with_capacity(flat.len() + cuts.iter().flatten().map(|c| c - 1).sum::<usize>());
    let mut counts = Vec::with_capacity(lens.len());
    let mut from = 0;
    for (&len, cut) in lens.iter().zip(cuts) {
        let start = out.len();
        let pts = &flat[from..from + len];
        for (j, &p) in pts.iter().enumerate() {
            out.push(p);
            if let Some(&c) = cut.get(j) {
                let q = pts[(j + 1) % len];
                out.extend((1..c).map(|s| {
                    let t = s as f64 / c as f64;
                    [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
                }));
            }
        }
        counts.push(out.len() - start);
        from += len;
    }
    (out, counts)
}

/// The points `offs` moved the fraction `e` of the way to `ends`, point for point; `offs` as they are without an end.
fn blend(offs: &[V3], ends: Option<&[V3]>, e: f64) -> Vec<V3> {
    match ends {
        Some(ends) => offs
            .iter()
            .zip(ends)
            .map(|(&a, &b)| vec3::add(a, vec3::scale(vec3::sub(b, a), e)))
            .collect(),
        None => offs.to_vec(),
    }
}

/// The start section `flat` and the end section of `to`, matched point for point: both with the same count, each
/// keeping its own corners, and a closed end turned to start where it lies least twisted from the start's. `to` is
/// closed or `open` as the profile is, and is drawn on the profile's own plane.
#[allow(
    clippy::cast_precision_loss,
    reason = "a ring has at most a few thousand points"
)]
fn end_ring(to: &Profile, open: bool, flat: &[V2]) -> Result<(Vec<V2>, Vec<V2>)> {
    if to.frame.is_some() {
        return Err(Error::invalid(
            "endProfile.frame",
            "the end profile is drawn on the profile's own plane; leave its frame out",
        ));
    }
    if to.open != open {
        return Err(Error::invalid(
            "endProfile",
            if open {
                "the profile is an open chain and the end profile is closed; both are open or both closed"
            } else {
                "the profile is closed and the end profile is an open chain; both are closed or both open"
            },
        ));
    }
    let mut last = if open {
        let mut c =
            sketch_loft::open_ring(&to.loops, "sweep").map_err(|why| Error::invalid("endProfile", why))?;
        if poly2d::signed_area(&c) < 0.0 {
            c.reverse();
        }
        c
    } else {
        sketch_loft::one_ring(&to.loops, "sweep").map_err(|why| Error::invalid("endProfile", why))?
    };
    let n = flat.len().max(last.len());
    let first = sketch_loft::resample(flat, n, !open);
    last = sketch_loft::resample(&last, n, !open);
    if !open {
        let middle = |r: &[V2]| {
            let s = r.iter().fold([0.0; 2], |a, p| [a[0] + p[0], a[1] + p[1]]);
            [s[0] / n as f64, s[1] / n as f64]
        };
        let (ca, cb) = (middle(&first), middle(&last));
        let shift = (0..n)
            .map(|s| {
                let d: f64 = (0..n)
                    .map(|i| {
                        let (a, b) = (first[i], last[(i + s) % n]);
                        ((a[0] - ca[0]) - (b[0] - cb[0])).m_powi(2)
                            + ((a[1] - ca[1]) - (b[1] - cb[1])).m_powi(2)
                    })
                    .sum();
                (d, s)
            })
            .fold((f64::INFINITY, 0), |best, x| if x.0 < best.0 { x } else { best })
            .1;
        last.rotate_left(shift);
    }
    Ok((first, last))
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

/// The centripetal Catmull-Rom curve through `pts` (the loft's smooth sides before they are held), its ends mirroring
/// their neighbors, flattened within the arc tolerance, and the directions it starts and ends in.
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

    /// The rings of a sweep's sides and each ring's loop lengths, read back from the order `build_rows` lays them out:
    /// row after row of loops, two triangles per side quad, and each loop's last quad joining back to its first point.
    fn rows_of(m: &TriMesh) -> (Vec<Vec<V3>>, Vec<usize>) {
        // the first quad's third corner is the second point of the second row
        let n = m.triangles[0][2] as usize - 1;
        let mut lens = Vec::new();
        let mut from = 0;
        for t in m.triangles.iter().step_by(2) {
            let (a0, a1) = (t[0] as usize, t[1] as usize);
            if a0 >= n {
                break;
            }
            if a1 < a0 {
                lens.push(a0 + 1 - from);
                from = a0 + 1;
            }
        }
        (m.positions.chunks(n).map(<[V3]>::to_vec).collect(), lens)
    }

    #[test]
    fn an_off_center_hole_stays_inside_every_twisted_squashed_ring() {
        // a 20 mm round with a 6 mm hole off its middle, a quarter turn and squashed to 0.6 along v round a quarter arc
        let path = chain([30.0, 0.0], vec![arc([0.0, 0.0], 90.0)]);
        let side = FaceFrame {
            origin: [30.0, 0.0, 0.0],
            normal: [0.0, 1.0, 0.0],
            u: [-1.0, 0.0, 0.0],
            v: [0.0, 0.0, 1.0],
        };
        let profile = Profile {
            frame: Some(side),
            loops: vec![circle([0.0, 0.0], 20.0), circle([3.0, 1.0], 6.0)],
            open: false,
            landmarks: Vec::new(),
        };
        let law = Law {
            scale_end: Scale::Each([1.0, 0.6]),
            twist_deg: 90.0,
            ease: Ease::Linear,
        };
        let m = sweep_with(&profile, &path, None, &law).unwrap();
        closed(&m);
        let (rows, lens) = rows_of(&m);
        assert_eq!(lens.len(), 2, "{lens:?}");
        assert_eq!(lens.iter().sum::<usize>(), rows[0].len());
        assert!(rows.len() > 2, "{}", rows.len());
        for (k, row) in rows.iter().enumerate() {
            let (outer, hole) = row.split_at(lens[0]);
            // each ring is flat: take it into its own plane through three of its outer points
            let (a, b, c) = (outer[0], outer[outer.len() / 3], outer[2 * outer.len() / 3]);
            let w = vec3::normalize(vec3::cross(vec3::sub(b, a), vec3::sub(c, a))).unwrap();
            let u = vec3::normalize(vec3::sub(b, a)).unwrap();
            let v = vec3::cross(w, u);
            let flat = |p: &V3| {
                let d = vec3::sub(*p, a);
                assert!(vec3::dot(d, w).abs() < 1e-6, "ring {k} is not flat");
                [vec3::dot(d, u), vec3::dot(d, v)]
            };
            let ring: Vec<V2> = outer.iter().map(flat).collect();
            let bore: Vec<V2> = hole.iter().map(flat).collect();
            // the hole winds against the outer loop, and every hole point is inside it, clear of its edges
            assert!(
                poly2d::signed_area(&ring) * poly2d::signed_area(&bore) < 0.0,
                "ring {k}"
            );
            for &p in &bore {
                assert!(poly2d::point_in_ring(p, &ring), "ring {k}: {p:?} is outside");
                let clear = (0..ring.len())
                    .map(|i| {
                        let (s, e) = (ring[i], ring[(i + 1) % ring.len()]);
                        let d = [e[0] - s[0], e[1] - s[1]];
                        let t = (((p[0] - s[0]) * d[0] + (p[1] - s[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1]))
                            .clamp(0.0, 1.0);
                        (p[0] - s[0] - d[0] * t).m_hypot(p[1] - s[1] - d[1] * t)
                    })
                    .fold(f64::INFINITY, f64::min);
                assert!(clear > 0.5, "ring {k}: {p:?} is {clear} mm from the outside");
            }
        }
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
        // a hole runs through as a bore: the 10 mm square less the 4 mm one, 10 mm long
        let bore = sweep(&holed, &up).unwrap();
        closed(&bore);
        assert!((bore.volume() - 840.0).abs() < 1e-9, "{}", bore.volume());
        let two = Profile {
            frame: None,
            loops: vec![square([0.0, 0.0], 10.0), square([30.0, 0.0], 10.0)],
            open: false,
            landmarks: Vec::new(),
        };
        assert_eq!(
            err(&two, &up),
            "profile: a sweep profile is one outer loop with any holes inside it, not 2 separate shapes"
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

    #[test]
    fn a_bore_swept_along_a_helix_comes_back_to_itself_each_turn() {
        // a 3 mm round with a 1.5 mm hole on the axial plane, 3 turns of a 6 mm pitch at 48 points a turn
        let pts = helix(35.0, 6.0, 3, 48);
        let f = FaceFrame::for_normal([35.0, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap();
        let profile = Profile {
            frame: Some(f),
            loops: vec![circle([0.0, 0.0], 3.0), circle([0.0, 0.0], 1.5)],
            open: false,
            landmarks: Vec::new(),
        };
        let m = sweep(&profile, &points(&pts)).unwrap();
        closed(&m);
        // one bore through it: a closed surface of genus one has no Euler characteristic
        let w = m.welded();
        assert_eq!(
            2 * w.positions.len(),
            w.triangles.len(),
            "V - E + F = V - F / 2 is 0"
        );
        let (rows, lens) = rows_of(&m);
        assert_eq!(lens.len(), 2, "{lens:?}");
        assert_eq!(rows.len(), pts.len());
        // every turn, outer loop and bore alike, is the first ring lifted by the pitch
        for turn in 1..=3 {
            for (p, q) in rows[0].iter().zip(&rows[turn * 48]) {
                let lifted = [p[0], p[1], p[2] + 6.0 * turn as f64];
                assert!(
                    vec3::len(vec3::sub(lifted, *q)) < 1e-9,
                    "turn {turn}: {q:?} vs {lifted:?}"
                );
            }
        }
    }

    #[test]
    #[allow(clippy::cast_possible_truncation, reason = "heights of a few mm")]
    fn an_eased_morph_adds_rings_where_the_blend_curves() {
        let square = bed(Loop {
            points: vec![[-10.0, -10.0], [10.0, -10.0], [10.0, 10.0], [-10.0, 10.0]],
            ..Loop::default()
        });
        let round = Profile {
            loops: vec![circle([0.0, 0.0], 20.0)],
            ..Profile::default()
        };
        let up = points(&[[0.0, 0.0, 0.0], [0.0, 0.0, 40.0]]);
        let levels = |m: &TriMesh| {
            let mut z: Vec<i64> = m.positions.iter().map(|p| (p[2] * 1e6).round() as i64).collect();
            z.sort_unstable();
            z.dedup();
            z.len()
        };
        // blended in step with the length, every point runs straight: the two ends only
        let linear = sweep_morph(&square, Some(&round), &up, None, &Law::default()).unwrap();
        closed(&linear);
        assert_eq!(levels(&linear), 2);
        let smooth = Law {
            ease: Ease::Smooth,
            ..Law::default()
        };
        let eased = sweep_morph(&square, Some(&round), &up, None, &smooth).unwrap();
        closed(&eased);
        assert!(levels(&eased) > 2, "{}", levels(&eased));
        // the same point count all along: the square takes the circle's
        let n = linear.positions.len() / 2;
        assert_eq!(eased.positions.len() % n, 0);
    }

    /// A thread tooth `w` wide at the root and `tall` high, at radius `r` on the axial plane, its crest 0.307 of its root.
    fn tooth_of(r: f64, w: f64, tall: f64) -> Profile {
        let f = FaceFrame::for_normal([r, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap();
        let (a, c) = (w / 2.0, w * 0.1536);
        on(
            f,
            Loop {
                points: vec![[0.0, -a], [tall, -c], [tall, c], [0.0, a]],
                ..Loop::default()
            },
        )
    }

    /// `turns` turns about z of a helix from radius `r`, growing `grow` mm a turn, `per` points a turn.
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a few hundred points"
    )]
    fn coil(r: f64, grow: f64, pitch: f64, turns: f64, per: usize) -> Vec<V3> {
        let n = (turns * per as f64).round() as usize;
        (0..=n)
            .map(|i| {
                let f = i as f64 / per as f64;
                let (s, c) = (2.0 * PI * f).m_sin_cos();
                let rr = r + grow * f;
                [rr * c, rr * s, pitch * f]
            })
            .collect()
    }

    /// The sweep, whether it left out the whole check, and whether that check finds it runs into itself.
    fn swept(profile: &Profile, pts: &[V3], law: &Law) -> (Result<TriMesh>, bool, bool) {
        let m = sweep_with(profile, &points(pts), None, law);
        let clear = CLEARED.get();
        let meets = m
            .as_ref()
            .is_ok_and(|m| boolean::Solid::new(m).is_ok_and(|s| s.self_intersects()));
        (m, clear, meets)
    }

    #[test]
    fn a_thread_whose_turns_stay_apart_leaves_out_the_whole_check() {
        for per in [48, 400] {
            let (m, clear, meets) = swept(&tooth(35.0), &helix(35.0, 4.0, 5, per), &Law::default());
            closed(&m.unwrap());
            assert!(clear, "{per} a turn");
            assert!(!meets, "{per} a turn");
        }
        // one steep turn comes back far above where it started
        let (m, clear, meets) = swept(&tooth(35.0), &helix(35.0, 20.0, 1, 48), &Law::default());
        assert!(m.is_ok() && clear && !meets);
    }

    #[test]
    fn turns_that_may_meet_are_checked_whole() {
        let plain = Law::default();
        // wider than the pitch: refused as before
        let (m, clear, _) = swept(&tooth_of(35.0, 4.5, 2.1), &helix(35.0, 4.0, 5, 48), &plain);
        assert!(m.is_err() && !clear);
        // less than a step's rise short of the pitch: the turns do not meet, but that is not shown
        let (m, clear, meets) = swept(&tooth_of(35.0, 3.95, 2.1), &helix(35.0, 4.0, 5, 48), &plain);
        assert!(m.is_ok() && !clear && !meets);
        // a taper that widens the tooth past the pitch by the end
        let wider = Law {
            scale_end: Scale::Even(1.3),
            ..Law::default()
        };
        let (m, clear, _) = swept(&tooth(35.0), &helix(35.0, 4.0, 5, 48), &wider);
        assert!(m.is_err() && !clear);
        // a cone whose turns nest, 2 mm in a turn and 1 mm up, round a 2.5 mm wire
        let wire = |r: f64| {
            on(
                FaceFrame::for_normal([r, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap(),
                circle([0.0, 0.0], 2.5),
            )
        };
        let (m, clear, _) = swept(&wire(35.0), &coil(35.0, -2.0, 1.0, 4.0, 48), &plain);
        assert!(m.is_err() && !clear);
        // the same cone 3 mm in a turn: its turns are apart from the axis, so that is shown
        let (m, clear, meets) = swept(&wire(35.0), &coil(35.0, -3.0, 1.0, 4.0, 48), &plain);
        assert!(m.is_ok() && clear && !meets);
        // less than a turn: checked whole
        let (m, clear, meets) = swept(&tooth(35.0), &coil(35.0, 0.0, 4.0, 0.75, 48), &plain);
        assert!(m.is_ok() && !clear && !meets);
    }

    #[test]
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "small counts"
    )]
    fn whenever_the_whole_check_is_left_out_it_finds_nothing() {
        let mut seed = 0x5eed_2026_u64;
        let mut rand = || {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let (mut left_out, mut checked, mut holed) = (0, 0, 0);
        for case in 0..100 {
            let r = 8.0 + 40.0 * rand();
            let pitch = 1.0 + 9.0 * rand();
            let w = pitch * (0.3 + 1.0 * rand());
            let tall = (0.5 + 3.0 * rand()).min(r / 3.0);
            let grow = if rand() < 0.3 { -2.0 * rand() } else { 0.0 };
            let turns = 1.0 + 2.0 * rand();
            let per = 12 + (36.0 * rand()) as usize;
            let law = if rand() < 0.3 {
                Law {
                    scale_end: Scale::Even(0.7 + 0.6 * rand()),
                    twist_deg: if rand() < 0.3 {
                        720.0 * rand()
                    } else {
                        40.0 * rand()
                    },
                    ..Law::default()
                }
            } else {
                Law::default()
            };
            let mut profile = tooth_of(r, w, tall);
            let bore = rand() < 0.5;
            if bore {
                profile.loops.push(bore_in(w, tall, 0.2 + 0.6 * rand()));
            }
            let (m, clear, meets) = swept(&profile, &coil(r, grow, pitch, turns, per), &law);
            if clear {
                left_out += 1;
                holed += usize::from(bore);
                assert!(
                    m.is_ok() && !meets,
                    "case {case}: left out, and the check finds it meets"
                );
            } else {
                checked += 1;
            }
        }
        assert!(
            left_out > 20 && checked > 20 && holed > 10,
            "{left_out} left out ({holed} with a bore), {checked} checked"
        );
    }

    /// A round hole in `tooth_of`'s tooth `w` wide and `tall` high, a third of the way up it, `fill` of the most it can
    /// take across.
    fn bore_in(w: f64, tall: f64, fill: f64) -> Loop {
        let (a, c) = (w / 2.0, w * 0.1536);
        let up = tall / 3.0;
        // the tooth's half width there, and the room to its root and its sides square to them
        let half = a - (a - c) * up / tall;
        let side = half * tall / (tall * tall + (a - c) * (a - c)).sqrt();
        circle([up, 0.0], 2.0 * fill * up.min(side))
    }

    #[test]
    fn a_holed_thread_whose_turns_and_loops_stay_apart_leaves_out_the_whole_check() {
        // a 3 mm round with a 1.5 mm hole, 3 turns of a 6 mm pitch, and the thread tooth with a bore along it
        let f = FaceFrame::for_normal([35.0, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap();
        let tube = Profile {
            frame: Some(f),
            loops: vec![circle([0.0, 0.0], 3.0), circle([0.0, 0.0], 1.5)],
            open: false,
            landmarks: Vec::new(),
        };
        let mut bored = tooth(35.0);
        bored.loops.push(bore_in(3.5, 2.1, 0.8));
        for (profile, pts) in [
            (&tube, helix(35.0, 6.0, 3, 48)),
            (&bored, helix(35.0, 4.0, 5, 48)),
            (&bored, helix(35.0, 4.0, 5, 400)),
        ] {
            let (m, clear, meets) = swept(profile, &pts, &Law::default());
            let m = m.unwrap();
            closed(&m);
            assert_eq!(rows_of(&m).1.len(), 2);
            // the check left out would have found nothing, and the mesh is the one it would have passed
            assert!(clear && !meets, "{} points", pts.len());
        }
    }

    #[test]
    fn holed_turns_that_may_meet_are_checked_whole() {
        let f = FaceFrame::for_normal([35.0, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap();
        let tube = |d: f64| Profile {
            frame: Some(f),
            loops: vec![circle([0.0, 0.0], d), circle([0.0, 0.0], d / 2.0)],
            open: false,
            landmarks: Vec::new(),
        };
        // wider than the pitch: refused as before
        let (m, clear, _) = swept(&tube(6.5), &helix(35.0, 6.0, 3, 48), &Law::default());
        assert!(m.is_err() && !clear);
        // less than a step's rise short of the pitch: the turns do not meet, but that is not shown
        let mut bored = tooth_of(35.0, 3.95, 2.1);
        bored.loops.push(bore_in(3.95, 2.1, 0.8));
        let (m, clear, meets) = swept(&bored, &helix(35.0, 4.0, 5, 48), &Law::default());
        assert!(m.is_ok() && !clear && !meets);
    }

    #[test]
    fn a_hole_wall_through_the_outer_wall_is_not_shown_apart() {
        let f = FaceFrame::for_normal([35.0, 0.0, 0.0], [0.0, -1.0, 0.0]).unwrap();
        let tube = Profile {
            frame: Some(f),
            loops: vec![circle([0.0, 0.0], 3.0), circle([0.0, 0.0], 1.5)],
            open: false,
            landmarks: Vec::new(),
        };
        let mut m = sweep(&tube, &points(&helix(35.0, 6.0, 3, 48))).unwrap();
        let (mut rings, lens) = rows_of(&m);
        let axis = ([0.0; 3], [0.0, 0.0, 1.0]);
        assert!(turns_clear(&m, &rings, &lens, axis, 3.0));
        // one hole point halfway along, pushed out from the middle of its ring past the outer wall
        let (k, j) = (rings.len() / 2, lens[0] + 3);
        let n = rings[0].len();
        let mid = sketch_loft::centroid(&rings[k][..lens[0]]);
        let out = vec3::add(mid, vec3::scale(vec3::sub(rings[k][j], mid), 2.5));
        rings[k][j] = out;
        m.positions[k * n + j] = out;
        assert!(boolean::Solid::new(&m).is_ok_and(|s| s.self_intersects()));
        assert!(!turns_clear(&m, &rings, &lens, axis, 3.0));
    }

    #[test]
    fn a_sweep_into_an_end_profile_takes_the_whole_check() {
        let into = |w: f64| {
            let (a, c) = (w / 2.0, w * 0.1536);
            Profile {
                loops: vec![Loop {
                    points: vec![[0.0, -a], [1.6, -c], [1.6, c], [0.0, a]],
                    ..Loop::default()
                }],
                ..Profile::default()
            }
        };
        let path = points(&helix(35.0, 4.0, 5, 48));
        // a thread tooth narrowing along a thread whose turns stay apart: the proof would show it, but the whole check
        // runs, finds nothing and the sweep goes ahead
        let m = sweep_morph(&tooth(35.0), Some(&into(2.4)), &path, None, &Law::default()).unwrap();
        closed(&m);
        assert!(!CLEARED.get());
        assert!(!boolean::Solid::new(&m).is_ok_and(|s| s.self_intersects()));
        let (rings, lens) = rows_of(&m);
        assert!(turns_clear(&m, &rings, &lens, ([0.0; 3], [0.0, 0.0, 1.0]), 37.1));
        // widening past the pitch by the end: the whole check refuses it
        let e = sweep_morph(&tooth(35.0), Some(&into(4.5)), &path, None, &Law::default()).unwrap_err();
        assert!(!CLEARED.get());
        assert!(e.to_string().contains("runs into itself"), "{e}");
    }
}
