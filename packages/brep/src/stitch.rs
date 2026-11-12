// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a solid from its faces: each face given by the curves it runs between, all of them joined along their shared
//! sides
//!
//! The caller says where every face is; the kernel only makes each face from its curves and joins them. Nothing
//! here fits or guesses a surface. What is given is checked in plain words before the kernel is asked, and the
//! joined result goes through [`Body::checked`] like every other body.

use crate::body::Body;
use crate::error::{Error, Result};
use crate::kernel;

/// The most faces one call joins.
pub const MAX_SHEETS: usize = 4096;
/// The most pieces one curve has, and the most curves one face runs across or is bounded by.
pub const MAX_PIECES: usize = 4096;
/// The widest gap between two faces the kernel may close to join them, as a share of the largest coordinate given
/// (of 1 mm when all are smaller). Faces that share a side are given the very same curve along it, so a real gap
/// there is rounding. The kernel closes far wider ones without a word, and then the solid is not the one asked for.
const MEET: f64 = 1e-9;

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
        .any(|&p| dot(sub(p, origin), normal).abs() > 1e-9 * size.max(1.0))
    {
        return Err(Error::input(what, "its loop does not lie in one plane"));
    }
    Ok(())
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
    /// first and last curves and on the straight or smooth line through its curves' ends. Faces that leave a gap,
    /// or that the kernel joins into anything but one closed solid, are refused and nothing is kept.
    pub fn stitched(sheets: &[Sheet]) -> Result<(Self, Vec<usize>)> {
        let mut order = Vec::new();
        let body = Self::checked(
            "stitch",
            || checked(sheets),
            || {
                let (solid, made, gap) = kernel::stitched(sheets)?;
                if gap.is_nan() || gap > MEET * size(sheets) {
                    return Err(Error::Apart { gap_mm: gap });
                }
                order = made;
                Ok(solid)
            },
        )?;
        Ok((body, order))
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
