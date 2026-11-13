// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! what the kernel made, read back against what it was given, and the one limit every such check holds to
//!
//! The kernel reports success for results that are not what was asked: it closes gaps, fits its own planes and
//! joins faces along curves it was not given. Each check here reads the result back and refuses it past [`meet`].

use crate::body::{Body, Frame, Surface};
use crate::error::{Error, Result};
use crate::stitch::{Path, Sheet, size};
use crate::tess::Tessellation;

/// The widest gap between two faces the kernel may close to join them, as a share of the largest coordinate given
/// (of 1 mm when all are smaller). Faces that share a side are given the very same curve along it, so a real gap
/// there is rounding. The kernel closes far wider ones without a word, and then the solid is not the one asked for.
pub(crate) const MEET: f64 = 1e-9;
/// How many stretches each piece of a curve a face was given is cut into, to be measured against the joined body's
/// edges at both ends of every stretch.
pub(crate) const STRETCHES: u32 = 32;
/// How closely the joined body is tessellated, in mm, for the points the kernel puts on each of its edges.
pub(crate) const EDGE_CHORD_MM: f64 = 1e-3;

pub(crate) fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(crate) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// How closely a result must hold to what was given, in mm, for every read-back here: [`MEET`] of the largest
/// coordinate given, `size` (of 1 mm when that is smaller).
pub(crate) fn meet(size: f64) -> f64 {
    MEET * size.max(1.0)
}

/// The gap the kernel reports it closed to join faces: none past the limit.
pub(crate) fn met(gap_mm: f64, limit: f64) -> Result<()> {
    if gap_mm.is_nan() || gap_mm > limit {
        return Err(Error::Apart { gap_mm });
    }
    Ok(())
}

/// How far a joined body's edges are from the curves its faces were given: no farther than the limit.
pub(crate) fn kept(off_mm: f64, limit: f64) -> Result<()> {
    if off_mm.is_nan() || off_mm > limit {
        return Err(Error::Moved { off_mm });
    }
    Ok(())
}

/// How far the farthest point given for a flat face's loop is from the plane the kernel put the face on, in mm.
pub(crate) fn off_its_plane(plane: &Frame, sides: &[Path]) -> f64 {
    sides
        .iter()
        .flat_map(Path::points)
        .map(|p| dot(sub(p, plane.origin), plane.z).abs())
        .fold(0.0, f64::max)
}

/// The kernel fits a flat face's plane to its loop itself, and takes a loop far less flat than the ones let
/// through here. Read back of the joined body: each flat face given is a plane, and every point of its loop is on
/// that plane as closely as two faces must meet.
pub(crate) fn flat_where_given(body: &Body, sheets: &[Sheet], order: &[usize]) -> Result<()> {
    let limit = meet(size(sheets));
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
pub(crate) fn off_line(point: [f64; 3], start: [f64; 3], end: [f64; 3]) -> f64 {
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
pub(crate) fn cubic_at(controls: &[[f64; 3]; 4], at: f64) -> [[f64; 3]; 3] {
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
pub(crate) fn off_cubic(point: [f64; 3], controls: &[[f64; 3]; 4]) -> f64 {
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
    pub(crate) fn off(&self, point: [f64; 3]) -> f64 {
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
    pub(crate) fn along(&self) -> Vec<[f64; 3]> {
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
pub(crate) fn straight(points: &[[f64; 3]], limit: f64) -> bool {
    match (points.first(), points.last()) {
        (Some(&start), Some(&end)) if dot(sub(end, start), sub(end, start)) > 0.0 => {
            points.iter().all(|&point| off_line(point, start, end) <= limit)
        }
        _ => false,
    }
}

impl Path {
    /// The same curve run the other way.
    pub(crate) fn reversed(&self) -> Self {
        match self {
            Self::Lines(points) => Self::Lines(points.iter().rev().copied().collect()),
            Self::Cubics(spans) => Self::Cubics(
                spans
                    .iter()
                    .rev()
                    .map(|&[p0, p1, p2, p3]| [p3, p2, p1, p0])
                    .collect(),
            ),
        }
    }

    /// The same curve with its first and last points set to `start` and `end`.
    pub(crate) fn pinned(mut self, start: [f64; 3], end: [f64; 3]) -> Self {
        match &mut self {
            Self::Lines(points) => {
                if let Some(first) = points.first_mut() {
                    *first = start;
                }
                if let Some(last) = points.last_mut() {
                    *last = end;
                }
            }
            Self::Cubics(spans) => {
                if let Some(first) = spans.first_mut() {
                    first[0] = start;
                }
                if let Some(last) = spans.last_mut() {
                    last[3] = end;
                }
            }
        }
        self
    }
}

/// The curves a face given as `sheet` runs between: a ruled or skinned face's first and last curves and, where its
/// curves' ends lie on one straight line, that line; a flat face's loop. A skinned face whose curves' ends do not
/// lie on a line runs its own smooth curve through them, which it was not given, so its edge with a flat face there
/// is held to the flat face's curves alone.
pub(crate) fn sides_of(sheet: &Sheet, limit: f64) -> Vec<Path> {
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
pub(crate) fn off_their_curves(body: &Body, sheets: &[Sheet], order: &[usize]) -> Result<f64> {
    let limit = meet(size(sheets));
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
