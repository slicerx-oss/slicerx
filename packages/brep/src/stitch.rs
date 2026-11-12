// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a solid from its faces: each face given by the curves it runs between, all of them joined along their shared
//! sides
//!
//! The caller says where every face is; the kernel only makes each face from its curves and joins them. Nothing
//! here fits or guesses a surface. What is given is checked in plain words before the kernel is asked, and the
//! joined result goes through [`Body::checked`] like every other body. Then every edge of the result is read back
//! against the curves its faces were given, since the kernel can join faces along a side that is on neither.

use crate::body::{Body, Frame, Surface};
use crate::error::{Error, Result};
use crate::kernel;
use crate::tess::Tessellation;

/// The most faces one call joins.
pub const MAX_SHEETS: usize = 4096;
/// The most pieces one curve has, and the most curves one face runs across or is bounded by.
pub const MAX_PIECES: usize = 4096;
/// The widest gap between two faces the kernel may close to join them, as a share of the largest coordinate given
/// (of 1 mm when all are smaller). Faces that share a side are given the very same curve along it, so a real gap
/// there is rounding. The kernel closes far wider ones without a word, and then the solid is not the one asked for.
const MEET: f64 = 1e-9;
/// How many stretches each piece of a curve a face was given is cut into, to be measured against the joined body's
/// edges at both ends of every stretch.
const STRETCHES: u32 = 32;
/// How closely the joined body is tessellated, in mm, for the points the kernel puts on each of its edges.
const EDGE_CHORD_MM: f64 = 1e-3;

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
    fn pieces(&self) -> usize {
        match self {
            Self::Lines(points) => points.len().saturating_sub(1),
            Self::Cubics(spans) => spans.len(),
        }
    }

    fn points(&self) -> impl Iterator<Item = [f64; 3]> + '_ {
        let (lines, cubics) = match self {
            Self::Lines(points) => (&points[..], &[][..]),
            Self::Cubics(spans) => (&[][..], &spans[..]),
        };
        lines.iter().copied().chain(cubics.iter().flatten().copied())
    }

    fn ends(&self) -> Option<([f64; 3], [f64; 3])> {
        match self {
            Self::Lines(points) => Some((*points.first()?, *points.last()?)),
            Self::Cubics(spans) => Some((spans.first()?[0], spans.last()?[3])),
        }
    }

    fn checked(&self, what: &'static str) -> Result<()> {
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

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Curves a face runs across: of one kind, with as many pieces each.
fn alike(what: &'static str, rails: &[&Path]) -> Result<()> {
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
fn flat(sides: &[Path]) -> Result<()> {
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
        .any(|&p| dot(sub(p, origin), normal).abs() > MEET * size.max(1.0))
    {
        return Err(Error::input(what, "its loop does not lie in one plane"));
    }
    Ok(())
}

/// How closely the joined body must hold to what was given, in mm, for every read-back here: the gap the kernel
/// reports, each flat face's plane and every edge. [`MEET`] of the largest coordinate given.
fn meet(sheets: &[Sheet]) -> f64 {
    MEET * size(sheets)
}

/// The largest coordinate of any point given, at least 1.
fn size(sheets: &[Sheet]) -> f64 {
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

/// How far the farthest point given for a flat face's loop is from the plane the kernel put the face on, in mm.
fn off_its_plane(plane: &Frame, sides: &[Path]) -> f64 {
    sides
        .iter()
        .flat_map(Path::points)
        .map(|p| dot(sub(p, plane.origin), plane.z).abs())
        .fold(0.0, f64::max)
}

/// The kernel fits a flat face's plane to its loop itself, and takes a loop far less flat than the ones let
/// through here. Read back of the joined body: each flat face given is a plane, and every point of its loop is on
/// that plane as closely as two faces must meet.
fn flat_where_given(body: &Body, sheets: &[Sheet], order: &[usize]) -> Result<()> {
    let limit = meet(sheets);
    for (face, &sheet) in body.faces()?.iter().zip(order) {
        let Some(Sheet::Flat(sides)) = sheets.get(sheet) else {
            continue;
        };
        let Surface::Plane { frame } = face.surface() else {
            return Err(Error::NotSolid {
                op: "flat face",
                why: "the kernel did not make it a plane",
            });
        };
        let off = off_its_plane(&frame, sides);
        if off.is_nan() || off > limit {
            return Err(Error::NotSolid {
                op: "flat face",
                why: "the kernel put it off the plane of its loop",
            });
        }
    }
    Ok(())
}

/// How far `point` is from the straight piece from `start` to `end`.
fn off_line(point: [f64; 3], start: [f64; 3], end: [f64; 3]) -> f64 {
    let way = sub(end, start);
    let length = dot(way, way);
    let share = if length > 0.0 {
        (dot(sub(point, start), way) / length).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let off = sub(point, [0, 1, 2].map(|i| start[i] + way[i] * share));
    dot(off, off).sqrt()
}

/// The cubic Bezier `controls` at `at`, and its first and second derivatives there.
fn cubic_at(controls: &[[f64; 3]; 4], at: f64) -> [[f64; 3]; 3] {
    let rest = 1.0 - at;
    let weights = [
        [
            rest * rest * rest,
            3.0 * rest * rest * at,
            3.0 * rest * at * at,
            at * at * at,
        ],
        [
            -3.0 * rest * rest,
            3.0 * rest * rest - 6.0 * rest * at,
            6.0 * rest * at - 3.0 * at * at,
            3.0 * at * at,
        ],
        [
            6.0 * rest,
            6.0 * at - 12.0 * rest,
            6.0 * rest - 12.0 * at,
            6.0 * at,
        ],
    ];
    weights.map(|weight| {
        let mut sum = [0.0; 3];
        for (control, w) in controls.iter().zip(weight) {
            for (coordinate, c) in sum.iter_mut().zip(control) {
                *coordinate += c * w;
            }
        }
        sum
    })
}

/// How far `point` is from the cubic Bezier `controls`, at the place along it where that is least: the nearest of
/// its points at [`STRETCHES`] even steps, closed in on by Newton's steps on where the curve runs square to the way
/// to `point`.
fn off_cubic(point: [f64; 3], controls: &[[f64; 3]; 4]) -> f64 {
    let gap = |at: f64| {
        let off = sub(cubic_at(controls, at)[0], point);
        dot(off, off).sqrt()
    };
    let (mut best, mut at) = (0..=STRETCHES)
        .map(|k| f64::from(k) / f64::from(STRETCHES))
        .map(|at| (gap(at), at))
        .fold(
            (f64::INFINITY, 0.0),
            |least, here| if here.0 < least.0 { here } else { least },
        );
    for _ in 0..16 {
        let [on, first, second] = cubic_at(controls, at);
        let off = sub(on, point);
        let slope = dot(first, first) + dot(off, second);
        if slope.abs() <= f64::MIN_POSITIVE {
            break;
        }
        at = (at - dot(off, first) / slope).clamp(0.0, 1.0);
        best = best.min(gap(at));
    }
    best
}

impl Path {
    /// How far `point` is from the curve.
    fn off(&self, point: [f64; 3]) -> f64 {
        match self {
            Self::Lines(points) => points
                .windows(2)
                .map(|pair| off_line(point, pair[0], pair[1]))
                .fold(f64::INFINITY, f64::min),
            Self::Cubics(spans) => spans
                .iter()
                .map(|controls| off_cubic(point, controls))
                .fold(f64::INFINITY, f64::min),
        }
    }

    /// Points along the curve: each piece's start and [`STRETCHES`] even steps along it, and the curve's end.
    fn along(&self) -> Vec<[f64; 3]> {
        let steps = (0..STRETCHES).map(|k| f64::from(k) / f64::from(STRETCHES));
        let mut out: Vec<[f64; 3]> = match self {
            Self::Lines(points) => points
                .windows(2)
                .flat_map(|pair| {
                    let (start, end) = (pair[0], pair[1]);
                    steps
                        .clone()
                        .map(move |share| [0, 1, 2].map(|i| start[i] + (end[i] - start[i]) * share))
                })
                .collect(),
            Self::Cubics(spans) => spans
                .iter()
                .flat_map(|controls| steps.clone().map(move |share| cubic_at(controls, share)[0]))
                .collect(),
        };
        out.extend(self.ends().map(|(_, end)| end));
        out
    }
}

/// Whether `points` lie on the straight line from the first to the last, as closely as two faces must meet.
fn straight(points: &[[f64; 3]], limit: f64) -> bool {
    match (points.first(), points.last()) {
        (Some(&start), Some(&end)) if dot(sub(end, start), sub(end, start)) > 0.0 => {
            points.iter().all(|&point| off_line(point, start, end) <= limit)
        }
        _ => false,
    }
}

/// The curves a face given as `sheet` runs between: a ruled or skinned face's first and last curves and, where its
/// curves' ends lie on one straight line, that line; a flat face's loop. A skinned face whose curves' ends do not
/// lie on a line runs its own smooth curve through them, which it was not given, so its edge with a flat face there
/// is held to the flat face's curves alone.
fn sides_of(sheet: &Sheet, limit: f64) -> Vec<Path> {
    let across = |rails: &[&Path]| {
        let mut out: Vec<Path> = rails
            .first()
            .into_iter()
            .chain(rails.last())
            .map(|&p| p.clone())
            .collect();
        let starts: Vec<[f64; 3]> = rails.iter().filter_map(|r| r.ends()).map(|e| e.0).collect();
        let ends: Vec<[f64; 3]> = rails.iter().filter_map(|r| r.ends()).map(|e| e.1).collect();
        for points in [starts, ends] {
            if straight(&points, limit) {
                out.push(Path::Lines(vec![points[0], points[points.len() - 1]]));
            }
        }
        out
    };
    match sheet {
        Sheet::Ruled(a, b) => across(&[a, b]),
        Sheet::Skinned(rails) => across(&rails.iter().collect::<Vec<_>>()),
        Sheet::Flat(sides) => sides.clone(),
    }
}

/// Read back of the joined body: how far its edges are from the curves its faces were given, in mm, both ways.
///
/// Each edge is measured at every point the kernel puts on it when it tessellates the body at a chord of
/// [`EDGE_CHORD_MM`], against the curves of each of the two faces it joins, and every piece of every curve given is
/// measured at both ends of [`STRETCHES`] even stretches against the nearest edge, by the kernel's own closest
/// point. Every one of those distances is exact. Between them, an edge that is the curve it was given differs from
/// it by rounding, and one that is a different curve through the same ends shows at the samples once it bows more
/// than a few hundredths of its stretch's length squared over its radius; so the line is held at the samples, not
/// proven between them.
fn off_their_curves(body: &Body, sheets: &[Sheet], order: &[usize]) -> Result<f64> {
    let limit = meet(sheets);
    let sides: Vec<Vec<Path>> = sheets.iter().map(|sheet| sides_of(sheet, limit)).collect();
    let mesh = body.tessellate(&Tessellation {
        chord_mm: EDGE_CHORD_MM,
        ..Tessellation::default()
    })?;
    let unknown = Error::NotSolid {
        op: "stitch",
        why: "the kernel gave an edge a face that was not given",
    };
    let mut worst = 0.0f64;
    let mut boxes = Vec::with_capacity(mesh.edges.len());
    let sheet_of = |face: u32| {
        order
            .get(face as usize)
            .copied()
            .filter(|&sheet| sheet < sheets.len())
            .ok_or_else(|| unknown.clone())
    };
    for edge in &mesh.edges {
        let points: Vec<[f64; 3]> = edge
            .points
            .iter()
            .filter_map(|&v| mesh.positions.get(v as usize).copied())
            .collect();
        let [one, other] = [sheet_of(edge.faces[0])?, sheet_of(edge.faces[1])?];
        for (sheet, beside) in [(one, other), (other, one)] {
            // a skinned face's own curve through its curves' ends, against a flat face: the flat face's loop holds it
            let open = matches!(sheets[sheet], Sheet::Skinned(_)) && sides[sheet].len() < 4;
            if open && sheet != beside && matches!(sheets[beside], Sheet::Flat(_)) {
                continue;
            }
            let curves = &sides[sheet];
            for &point in &points {
                worst = worst.max(
                    curves
                        .iter()
                        .map(|curve| curve.off(point))
                        .fold(f64::INFINITY, f64::min),
                );
            }
        }
        // the box around the edge's points: the edge is within a chord of the straight pieces between them
        let low: [f64; 3] =
            std::array::from_fn(|i| points.iter().map(|p| p[i]).fold(f64::INFINITY, f64::min));
        let high: [f64; 3] =
            std::array::from_fn(|i| points.iter().map(|p| p[i]).fold(f64::NEG_INFINITY, f64::max));
        boxes.push((low, high));
    }
    let edges = body.solid().edges()?;
    if edges.len() != boxes.len() {
        return Err(Error::NotSolid {
            op: "stitch",
            why: "the kernel's tessellation has other edges than the body",
        });
    }
    let reach = EDGE_CHORD_MM + limit;
    for point in sides.iter().flatten().flat_map(Path::along) {
        let mut near = f64::INFINITY;
        for (edge, (low, high)) in edges.iter().zip(&boxes) {
            if (0..3).all(|i| point[i] >= low[i] - reach && point[i] <= high[i] + reach) {
                near = near.min(edge.distance_to(point.into())?);
            }
        }
        worst = worst.max(near);
    }
    Ok(worst)
}

/// What the kernel must not be asked, in plain words.
fn checked(sheets: &[Sheet]) -> Result<()> {
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
                if gap.is_nan() || gap > meet(sheets) {
                    return Err(Error::Apart { gap_mm: gap });
                }
                order = made;
                Ok(solid)
            },
        )?;
        flat_where_given(&body, sheets, &order)?;
        let off = off_their_curves(&body, sheets, &order)?;
        if off.is_nan() || off > meet(sheets) {
            return Err(Error::Moved { off_mm: off });
        }
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
