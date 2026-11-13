// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a solid from its faces: each face given by the curves it runs between, all of them joined along their shared
//! sides
//!
//! The caller says where every face is; the kernel only makes each face from its curves and joins them. Nothing
//! here fits or guesses a surface. What is given is checked in plain words before the kernel is asked, and the
//! joined result goes through [`Body::checked`] like every other body. Then every edge of the result is read back
//! against the curves its faces were given, since the kernel can join faces along a side that is on neither.

use crate::body::Body;
#[cfg(test)]
use crate::body::Frame;
use crate::error::{Error, Result};
use crate::kernel;
#[cfg(test)]
use crate::readback::off_its_plane;
use crate::readback::{cross, dot, flat_where_given, kept, meet, met, off_their_curves, sub};

/// The most faces one call joins.
pub const MAX_SHEETS: usize = 4096;
/// The most pieces one curve has, and the most curves one face runs across or is bounded by.
pub const MAX_PIECES: usize = 4096;
/// How far an exact face may come out from the curves it was drawn from, in mm. It is a distance to the drawing, not
/// a gap the kernel closes: a face skinned across rails through a drawn curve passes through the rails' points on it
/// exactly and between them only as closely as its interpolation runs, and this is how closely that must be.
pub const DRAWN_MM: f64 = 0.01;

/// A curve in space, by its control points. The kernel holds it exactly as given.
#[derive(Debug, Clone, PartialEq)]
pub enum Path {
    /// Straight from each point to the next.
    Lines(Vec<[f64; 3]>),
    /// Cubic Bezier pieces, each starting on the point the one before ends on.
    Cubics(Vec<[[f64; 3]; 4]>),
}

/// One face of a solid to be joined from faces.
#[derive(Debug, Clone, PartialEq)]
pub enum Sheet {
    /// Straight lines from each point of one curve to the point of the other at the same place along it. The two
    /// curves are of one kind and have as many pieces.
    Ruled(Path, Path),
    /// A smooth surface through every one of these curves in order, each a line of the surface. They run the same
    /// way, are of one kind and have as many pieces. Two of them make a ruled face.
    Skinned(Vec<Path>),
    /// A flat face inside a closed loop of curves, each starting on the point the one before ends on and the last
    /// ending on the first one's start.
    Flat(Vec<Path>),
}

impl Path {
    pub(crate) fn pieces(&self) -> usize {
        match self {
            Self::Lines(points) => points.len().saturating_sub(1),
            Self::Cubics(spans) => spans.len(),
        }
    }

    pub(crate) fn points(&self) -> impl Iterator<Item = [f64; 3]> + '_ {
        let (lines, cubics) = match self {
            Self::Lines(points) => (&points[..], &[][..]),
            Self::Cubics(spans) => (&[][..], &spans[..]),
        };
        lines.iter().copied().chain(cubics.iter().flatten().copied())
    }

    pub(crate) fn ends(&self) -> Option<([f64; 3], [f64; 3])> {
        match self {
            Self::Lines(points) => Some((*points.first()?, *points.last()?)),
            Self::Cubics(spans) => Some((spans.first()?[0], spans.last()?[3])),
        }
    }

    pub(crate) fn checked(&self, what: &'static str) -> Result<()> {
        if self.pieces() == 0 {
            return Err(Error::input(
                what,
                "a curve needs 2 or more points, or 1 or more pieces",
            ));
        }
        if self.pieces() > MAX_PIECES {
            return Err(Error::input(
                what,
                format!("a curve has at most {MAX_PIECES} pieces"),
            ));
        }
        if self.points().flatten().any(|c| !c.is_finite()) {
            return Err(Error::input(what, "every point must be finite numbers"));
        }
        let same = |a: [f64; 3], b: [f64; 3]| a.iter().zip(&b).all(|(a, b)| a.to_bits() == b.to_bits());
        let (joined, lengths) = match self {
            Self::Lines(points) => (true, points.windows(2).all(|p| !same(p[0], p[1]))),
            Self::Cubics(spans) => (
                spans.windows(2).all(|s| same(s[0][3], s[1][0])),
                spans.iter().all(|s| s[1..].iter().any(|&p| !same(p, s[0]))),
            ),
        };
        if !joined {
            return Err(Error::input(
                what,
                "each piece of a curve must start on the point the one before ends on",
            ));
        }
        if !lengths {
            return Err(Error::input(what, "a curve has a piece of no length"));
        }
        Ok(())
    }
}

/// Curves a face runs across: of one kind, with as many pieces each.
pub(crate) fn alike(what: &'static str, rails: &[&Path]) -> Result<()> {
    if rails.len() < 2 {
        return Err(Error::input(what, "a face runs across 2 or more curves"));
    }
    if rails.len() > MAX_PIECES {
        return Err(Error::input(
            what,
            format!("a face runs across at most {MAX_PIECES} curves"),
        ));
    }
    rails.iter().try_for_each(|r| r.checked(what))?;
    let first = rails[0];
    let kind = |p: &Path| matches!(p, Path::Lines(_));
    if rails
        .iter()
        .any(|&r| kind(r) != kind(first) || r.pieces() != first.pieces())
    {
        return Err(Error::input(
            what,
            "its curves must be of one kind and have as many pieces each",
        ));
    }
    Ok(())
}

/// A flat face's loop: closed, and flat to within a billionth of its size.
pub(crate) fn flat(sides: &[Path]) -> Result<()> {
    let what = "flat face";
    if sides.is_empty() {
        return Err(Error::input(what, "needs a loop of curves around it"));
    }
    if sides.len() > MAX_PIECES {
        return Err(Error::input(
            what,
            format!("a loop has at most {MAX_PIECES} curves"),
        ));
    }
    sides.iter().try_for_each(|s| s.checked(what))?;
    let same = |a: [f64; 3], b: [f64; 3]| a.iter().zip(&b).all(|(a, b)| a.to_bits() == b.to_bits());
    let closed = (0..sides.len()).all(|i| {
        let next = &sides[(i + 1) % sides.len()];
        matches!((sides[i].ends(), next.ends()), (Some((_, end)), Some((start, _))) if same(end, start))
    });
    if !closed {
        return Err(Error::input(
            what,
            "its loop is not closed: each curve must start on the point the one before ends on",
        ));
    }
    let points: Vec<[f64; 3]> = sides.iter().flat_map(Path::points).collect();
    let origin = points[0];
    // the loop's area vector: its direction is the plane's normal, whatever the loop's shape
    let mut area = [0.0; 3];
    for pair in points.windows(2) {
        let c = cross(sub(pair[0], origin), sub(pair[1], origin));
        area = [area[0] + c[0], area[1] + c[1], area[2] + c[2]];
    }
    let size = points
        .iter()
        .map(|&p| dot(sub(p, origin), sub(p, origin)).sqrt())
        .fold(0.0, f64::max);
    let length = dot(area, area).sqrt();
    if length <= 1e-12 * size * size {
        return Err(Error::input(what, "its loop encloses no area"));
    }
    let normal = area.map(|c| c / length);
    if points
        .iter()
        .any(|&p| dot(sub(p, origin), normal).abs() > meet(size))
    {
        return Err(Error::input(what, "its loop does not lie in one plane"));
    }
    Ok(())
}

/// The largest coordinate of any point given, at least 1.
pub(crate) fn size(sheets: &[Sheet]) -> f64 {
    sheets
        .iter()
        .flat_map(|sheet| match sheet {
            Sheet::Ruled(a, b) => vec![a, b],
            Sheet::Skinned(paths) | Sheet::Flat(paths) => paths.iter().collect(),
        })
        .flat_map(Path::points)
        .flatten()
        .fold(1.0_f64, |most, c| most.max(c.abs()))
}

/// A curve the kernel read off a surface: its degree, its whole knot list, its control points, and the gap it says
/// the curve has from the surface, in mm.
pub(crate) struct Boundary {
    pub(crate) degree: f64,
    pub(crate) rational: bool,
    pub(crate) knots: Vec<f64>,
    pub(crate) points: Vec<[f64; 3]>,
    pub(crate) gap: f64,
}

/// One more knot at `at`, inside the curve, with the curve unchanged (Boehm's insertion).
pub(crate) fn with_knot(
    degree: usize,
    knots: &mut Vec<f64>,
    points: &mut Vec<[f64; 3]>,
    at: f64,
) -> Option<()> {
    let span = knots.iter().rposition(|&knot| knot <= at)?;
    let first = span.checked_sub(degree)?;
    let mut out = Vec::with_capacity(points.len() + 1);
    for i in 0..=points.len() {
        if i <= first {
            out.push(*points.get(i)?);
        } else if i > span {
            out.push(*points.get(i - 1)?);
        } else {
            let (lo, hi) = (*knots.get(i)?, *knots.get(i + degree)?);
            let share = (at - lo) / (hi - lo);
            let (before, after) = (*points.get(i - 1)?, *points.get(i)?);
            out.push([0, 1, 2].map(|axis| before[axis] + (after[axis] - before[axis]) * share));
        }
    }
    knots.insert(span + 1, at);
    *points = out;
    Some(())
}

impl Boundary {
    /// The same curve as straight pieces (degree 1) or cubic Bezier pieces (degree 2 and 3): each inner knot is
    /// repeated up to the degree, which splits the curve into pieces without changing it, and a quadratic piece is
    /// written as the cubic it is. Refused, in words, when it is rational, of a degree above 3, or not pinned to its
    /// end points.
    #[allow(
        clippy::float_cmp,
        reason = "the kernel's own knots and degree, compared as it gave them"
    )]
    pub(crate) fn path(&self) -> Result<Path> {
        let what = "skinned face curve";
        let refused = |why: &'static str| Error::NotSolid { op: what, why };
        if self.rational {
            return Err(refused("the kernel read it as a rational curve"));
        }
        let degree = match self.degree {
            1.0 => 1,
            2.0 => 2,
            3.0 => 3,
            _ => return Err(refused("the kernel read it as a curve of a degree above 3")),
        };
        let (mut knots, mut points) = (self.knots.clone(), self.points.clone());
        let pinned = knots.len() == points.len() + degree + 1
            && points.len() > degree
            && knots[..=degree].iter().all(|&knot| knot == knots[0])
            && knots[knots.len() - degree - 1..]
                .iter()
                .all(|&knot| knot == knots[knots.len() - 1]);
        if !pinned {
            return Err(refused(
                "the kernel read it as a curve not pinned to its end points",
            ));
        }
        let inner: Vec<f64> = {
            let mut seen = knots[degree + 1..knots.len() - degree - 1].to_vec();
            seen.dedup();
            seen
        };
        for at in inner {
            while knots.iter().filter(|&&knot| knot == at).count() < degree {
                with_knot(degree, &mut knots, &mut points, at)
                    .ok_or_else(|| refused("its knots could not be split"))?;
            }
        }
        if degree == 1 {
            return Ok(Path::Lines(points));
        }
        let spans = points
            .windows(degree + 1)
            .step_by(degree)
            .map(|piece| match *piece {
                [p0, p1, p2] => [
                    p0,
                    [0, 1, 2].map(|axis| p0[axis] + (p1[axis] - p0[axis]) * 2.0 / 3.0),
                    [0, 1, 2].map(|axis| p2[axis] + (p1[axis] - p2[axis]) * 2.0 / 3.0),
                    p2,
                ],
                [p0, p1, p2, p3] => [p0, p1, p2, p3],
                _ => [[f64::NAN; 3]; 4],
            })
            // a piece the kernel left with no length, where a knot was already repeated, is no piece
            .filter(|piece| piece[1..].iter().any(|point| point != &piece[0]))
            .collect();
        Ok(Path::Cubics(spans))
    }
}

/// The two curves a face skinned across `rails` ends on, read from the kernel's own surface: the one through every
/// rail's start, then the one through every rail's end. A flat face given one of them meets the skin on the very curve
/// the kernel made, where a curve worked out here only passes through the same points. They are the first and last
/// of [`skin_stations`], and read back as those are.
pub fn skin_ends(rails: &[Path]) -> Result<(Path, Path)> {
    let mut stations = skin_stations(rails)?;
    match (stations.pop(), stations.into_iter().next()) {
        (Some(last), Some(first)) => Ok((first, last)),
        _ => Err(Error::input(
            "skinned face",
            "a face runs across 2 or more curves",
        )),
    }
}

/// The curves a face skinned across `rails` runs along at each of the rails' stations, in order from their starts to
/// their ends, read from the kernel's own surface. A station is where every rail's pieces meet: its start, the end
/// of each piece and its end. A drawing made at the stations can be measured against these, as the face itself.
///
/// The rails are checked in words before the kernel is asked, as for [`Body::stitched`]. Read back: each curve passes
/// through every rail's point at its station, and the kernel says it read it with no gap from the surface, both within
/// [`MEET`] of the largest coordinate given. Each runs from the first rail's point to the last one's, and starts and
/// ends on exactly those points.
pub fn skin_stations(rails: &[Path]) -> Result<Vec<Path>> {
    let what = "skinned face";
    alike(what, &rails.iter().collect::<Vec<_>>())?;
    let limit = meet(size(&[Sheet::Skinned(rails.to_vec())]));
    let pieces = rails.first().map_or(0, Path::pieces);
    // each rail's point at station `k`
    let station = |rail: &Path, k: usize| match rail {
        Path::Lines(points) => points[k],
        Path::Cubics(spans) if k < spans.len() => spans[k][0],
        Path::Cubics(spans) => spans[spans.len() - 1][3],
    };
    #[allow(clippy::cast_precision_loss, reason = "a piece count")]
    let at: Vec<(i32, f64)> = [0, 1]
        .into_iter()
        .flat_map(|direction| (0..=pieces).map(move |k| (direction, k as f64 / pieces as f64)))
        .collect();
    let read = kernel::skin_curves(rails, &at)?;
    let refused = |why: &'static str| Error::NotSolid {
        op: "skinned face curve",
        why,
    };
    // the stations run one way across the surface: the way whose curves pass through every station's points
    for curves in read.chunks(pieces + 1) {
        let mut out = Vec::with_capacity(pieces + 1);
        let mut exact = true;
        for (k, curve) in curves.iter().enumerate() {
            let Ok(path) = curve.path() else { break };
            let points: Vec<[f64; 3]> = rails.iter().map(|rail| station(rail, k)).collect();
            if points.iter().any(|&point| path.off(point) > limit) {
                break;
            }
            exact &= curve.gap.is_finite() && curve.gap <= limit;
            let (Some(&from), Some(&to)) = (points.first(), points.last()) else {
                break;
            };
            out.push(oriented(path, from, to, limit));
        }
        if out.len() == pieces + 1 {
            return if exact {
                Ok(out)
            } else {
                Err(refused("the kernel read it only approximately"))
            };
        }
    }
    Err(refused(
        "the kernel's surface does not run through its curves at their stations",
    ))
}

/// `path` run from `from` to `to`, and starting and ending on exactly those points: the kernel's own end points are
/// them to rounding, and a loop of curves must join on the same numbers.
pub(crate) fn oriented(path: Path, from: [f64; 3], to: [f64; 3], limit: f64) -> Path {
    let path = match path.ends() {
        Some((start, _))
            if path.off(to) <= limit
                && dot(sub(start, to), sub(start, to)) < dot(sub(start, from), sub(start, from)) =>
        {
            path.reversed()
        }
        _ => path,
    };
    path.pinned(from, to)
}

/// How far apart two curves are, in mm: the farthest any of either's points along it is from the other, at each
/// piece's ends and [`STRETCHES`] even steps along it.
pub fn apart(a: &Path, b: &Path) -> f64 {
    let one_way = |from: &Path, to: &Path| from.along().into_iter().map(|p| to.off(p)).fold(0.0, f64::max);
    one_way(a, b).max(one_way(b, a))
}

/// What the kernel must not be asked, in plain words.
pub(crate) fn checked(sheets: &[Sheet]) -> Result<()> {
    if sheets.len() < 2 {
        return Err(Error::input("faces", "a solid needs 2 or more faces"));
    }
    if sheets.len() > MAX_SHEETS {
        return Err(Error::input(
            "faces",
            format!("at most {MAX_SHEETS} faces are joined at once"),
        ));
    }
    sheets.iter().try_for_each(|sheet| match sheet {
        Sheet::Ruled(a, b) => alike("ruled face", &[a, b]),
        Sheet::Skinned(rails) => alike("skinned face", &rails.iter().collect::<Vec<_>>()),
        Sheet::Flat(sides) => flat(sides),
    })
}

impl Body {
    /// The solid these faces close when joined along their shared sides, and for each face of the body, in the
    /// body's face order, which of `sheets` it is.
    ///
    /// Two faces share a side when the curves along it are the same curve: a ruled or skinned face ends on its
    /// first and last curves and on the straight line through its curves' ends. Faces that leave a gap, or that the
    /// kernel joins into anything but one closed solid, are refused and nothing is kept. So is a flat face the
    /// kernel put anywhere but on the plane of its loop, and a body with an edge off the curves its faces were
    /// given.
    pub fn stitched(sheets: &[Sheet]) -> Result<(Self, Vec<usize>)> {
        Self::stitched_off(sheets).map(|(body, order, _)| (body, order))
    }

    /// [`Body::stitched`], with how far the body's edges are from the curves its faces were given, in mm: at most a
    /// billionth of the largest coordinate given, or the faces are refused.
    pub fn stitched_off(sheets: &[Sheet]) -> Result<(Self, Vec<usize>, f64)> {
        let mut order = Vec::new();
        let body = Self::checked(
            "stitch",
            || checked(sheets),
            || {
                let (solid, made, gap) = kernel::stitched(sheets)?;
                met(gap, meet(size(sheets)))?;
                order = made;
                Ok(solid)
            },
        )?;
        flat_where_given(&body, sheets, &order)?;
        let off = off_their_curves(&body, sheets, &order)?;
        kept(off, meet(size(sheets)))?;
        Ok((body, order, off))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn why(sheets: &[Sheet]) -> String {
        checked(sheets).expect_err("a refusal").to_string()
    }

    fn line(a: [f64; 3], b: [f64; 3]) -> Path {
        Path::Lines(vec![a, b])
    }

    fn square(z: f64) -> Vec<Path> {
        let at = |x: f64, y: f64| [x, y, z];
        vec![
            line(at(0.0, 0.0), at(1.0, 0.0)),
            line(at(1.0, 0.0), at(1.0, 1.0)),
            line(at(1.0, 1.0), at(0.0, 1.0)),
            line(at(0.0, 1.0), at(0.0, 0.0)),
        ]
    }

    #[test]
    fn faces_are_refused_in_words_before_the_kernel_is_asked() {
        let cap = Sheet::Flat(square(0.0));
        assert_eq!(
            why(std::slice::from_ref(&cap)),
            "faces: a solid needs 2 or more faces"
        );
        let with = |sheet: Sheet| why(&[cap.clone(), sheet]);
        let (a, b) = (
            line([0.0; 3], [1.0, 0.0, 0.0]),
            line([0.0, 0.0, 1.0], [1.0, 0.0, 1.0]),
        );
        assert_eq!(
            with(Sheet::Ruled(a.clone(), Path::Lines(vec![[0.0; 3]]))),
            "ruled face: a curve needs 2 or more points, or 1 or more pieces"
        );
        assert_eq!(
            with(Sheet::Ruled(
                a.clone(),
                line([0.0, f64::NAN, 1.0], [1.0, 0.0, 1.0])
            )),
            "ruled face: every point must be finite numbers"
        );
        assert_eq!(
            with(Sheet::Ruled(a.clone(), line([2.0; 3], [2.0; 3]))),
            "ruled face: a curve has a piece of no length"
        );
        assert_eq!(
            with(Sheet::Ruled(a.clone(), Path::Cubics(vec![[[3.0; 3]; 4]]))),
            "ruled face: a curve has a piece of no length"
        );
        let third = |t: f64| [t, 0.0, 1.0];
        let cubic = Path::Cubics(vec![[third(0.0), third(1.0), third(2.0), third(3.0)]]);
        assert_eq!(
            with(Sheet::Ruled(a.clone(), cubic.clone())),
            "ruled face: its curves must be of one kind and have as many pieces each"
        );
        let apart = Path::Cubics(vec![
            [third(0.0), third(1.0), third(2.0), third(3.0)],
            [third(3.5), third(4.0), third(5.0), third(6.0)],
        ]);
        assert_eq!(
            with(Sheet::Ruled(apart, cubic)),
            "ruled face: each piece of a curve must start on the point the one before ends on"
        );
        assert_eq!(
            with(Sheet::Skinned(vec![a.clone()])),
            "skinned face: a face runs across 2 or more curves"
        );
        assert_eq!(checked(&[cap.clone(), Sheet::Skinned(vec![a, b])]), Ok(()));
    }

    #[test]
    fn a_loop_is_measured_from_the_plane_its_face_is_on() {
        let plane = |origin: [f64; 3], z: [f64; 3]| Frame {
            origin,
            x: [1.0, 0.0, 0.0],
            y: [0.0, 1.0, 0.0],
            z,
        };
        let on = off_its_plane(&plane([7.0, -3.0, 1.0], [0.0, 0.0, 1.0]), &square(1.0));
        assert!(on.abs() < 1e-15, "{on:e}");
        // the plane a quarter of a mm above the loop, and one that leans away from it
        let above = off_its_plane(&plane([0.0, 0.0, 1.25], [0.0, 0.0, -1.0]), &square(1.0));
        assert!((above - 0.25).abs() < 1e-15, "{above:e}");
        let leaning = off_its_plane(&plane([0.0, 0.0, 1.0], [0.6, 0.0, 0.8]), &square(1.0));
        assert!((leaning - 0.6).abs() < 1e-15, "{leaning:e}");
    }

    #[test]
    fn a_flat_face_needs_a_closed_loop_in_one_plane() {
        let cap = Sheet::Flat(square(0.0));
        let with = |sides: Vec<Path>| why(&[cap.clone(), Sheet::Flat(sides)]);
        assert_eq!(with(Vec::new()), "flat face: needs a loop of curves around it");
        let mut open = square(1.0);
        open.pop();
        assert_eq!(
            with(open),
            "flat face: its loop is not closed: each curve must start on the point the one before ends on"
        );
        let mut bent = square(1.0);
        bent[1] = line([1.0, 0.0, 1.0], [1.0, 1.0, 1.5]);
        bent[2] = line([1.0, 1.0, 1.5], [0.0, 1.0, 1.0]);
        assert_eq!(with(bent), "flat face: its loop does not lie in one plane");
        let there = line([0.0; 3], [1.0, 0.0, 0.0]);
        let back = line([1.0, 0.0, 0.0], [0.0; 3]);
        assert_eq!(with(vec![there, back]), "flat face: its loop encloses no area");
        assert_eq!(checked(&[cap, Sheet::Flat(square(1.0))]), Ok(()));
    }
}
