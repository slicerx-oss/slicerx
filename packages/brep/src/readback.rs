// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! what the kernel made, read back against what it was given, and the one limit every such check holds to
//!
//! The kernel reports success for results that are not what was asked: it closes gaps, fits its own planes and
//! joins faces along curves it was not given. Each check here reads the result back and refuses it past [`meet`].

use crate::body::{Body, Frame, Surface};
use crate::error::{Error, Result};
use crate::kernel::{EdgeRef, FaceRef};
use crate::stitch::{Path, Sheet, size};
use crate::tess::Tessellation;
use crate::values::{Polygons, Shape, Vec3};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};

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
    let mesh = body.tessellate_as_made(&Tessellation {
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

/// The most rounds of splitting [`held_to_chord`] makes before it refuses. Each round halves the sides of every
/// triangle that is too far from its surface, which cuts the distance about four times.
const REFINE_ROUNDS: usize = 12;
/// The most triangles one face may come to while it is split.
const REFINE_FACE_TRIANGLES: usize = 400_000;
/// The most places triangles are measured at in one read-back, over all its rounds.
const REFINE_SAMPLES: usize = 8_000_000;
/// The most times one read-back asks a face for its closest point, which is what costs: from a hundredth of a
/// millisecond on a ball to half a millisecond on a spline face that wraps a hull. Counted on 2026-11-13: a smooth
/// hull of 8 stations takes 814 at a chord of 0.01 mm and 4370 at 0.002 mm, a hull of 18 drawn sections 2284 and
/// 9564, a ball of 5 mm 4224, a hull with 275 holes through it 1483. Three times the most of those.
const REFINE_SOLVES: usize = 30_000;
/// How many steps a measured place takes toward the point it is measured from.
const BOUND_STEPS: usize = 2;
/// How far toward its triangle's middle a corner's place on the surface is drawn before the surface is asked there,
/// as a share of the way.
const INWARD: f64 = 1e-9;
/// How many steps a new corner's place takes toward its point, and how near, in mm, is there.
const PLACE_STEPS: usize = 16;
const PLACED_MM: f64 = 1e-9;

/// A corner of a triangle as the kernel's mesh has it: its point, the normal stored there, the kernel's record
/// that holds it, and where it is on its face's surface.
#[derive(Clone, Copy)]
struct Corner {
    vertex: u32,
    normal: Option<Vec3>,
    record: Option<u32>,
    uv: Option<[f64; 2]>,
}

/// A side of a triangle: its two vertices, the lower first.
type Side = (u32, u32);
/// A new corner's place among the others: its side, its face, and the records at the side's two ends.
type Place = (Side, u32, Option<u32>, Option<u32>);

fn side(a: u32, b: u32) -> Side {
    (a.min(b), a.max(b))
}

fn mean<const N: usize>(points: [[f64; 3]; N]) -> [f64; 3] {
    #[allow(clippy::cast_precision_loss, reason = "two or three")]
    let n = N as f64;
    [0, 1, 2].map(|k| points.iter().map(|p| p[k]).sum::<f64>() / n)
}

fn point(mesh: &Polygons, vertex: u32) -> [f64; 3] {
    mesh.positions
        .get(vertex as usize)
        .copied()
        .map_or([f64::NAN; 3], Into::into)
}

fn corner(mesh: &Polygons, triangle: usize, k: usize) -> Corner {
    Corner {
        vertex: mesh.triangles[triangle][k],
        normal: mesh.normals[triangle][k],
        record: mesh.records[triangle][k],
        uv: mesh.uvs[triangle][k],
    }
}

/// The corners a triangle has at the two ends of a side, the lower vertex's first.
fn ends(mesh: &Polygons, triangle: usize, of: Side) -> Option<[Corner; 2]> {
    let at = |vertex: u32| {
        let k = mesh.triangles[triangle].iter().position(|&p| p == vertex)?;
        Some(corner(mesh, triangle, k))
    };
    Some([at(of.0)?, at(of.1)?])
}

fn coarse(off_mm: f64, chord_mm: f64) -> Error {
    Error::Coarse { off_mm, chord_mm }
}

/// A triangle as the surface's own parameters see it: its three points, and where each is on the surface.
#[derive(Clone, Copy)]
struct Patch {
    points: [[f64; 3]; 3],
    uvs: [[f64; 2]; 3],
}

impl Patch {
    /// Each corner's place is drawn a little toward the triangle's middle ([`INWARD`]): the kernel stores a place
    /// on the end of a surface's range a hair past it, where the surface cannot be asked.
    fn new(points: [[f64; 3]; 3], uvs: [[f64; 2]; 3]) -> Self {
        let middle = [0, 1].map(|k| (uvs[0][k] + uvs[1][k] + uvs[2][k]) / 3.0);
        Self {
            points,
            uvs: uvs.map(|uv| [0, 1].map(|k| uv[k] + (middle[k] - uv[k]) * INWARD)),
        }
    }

    fn of(corners: [Corner; 3], mesh: &Polygons) -> Option<Self> {
        let [first, second, third] = corners;
        Some(Self::new(
            corners.map(|corner| point(mesh, corner.vertex)),
            [first.uv?, second.uv?, third.uv?],
        ))
    }

    /// Where on the surface a place in the triangle is: `shares` are how much of the second and of the third
    /// corner it has, the rest being the first's.
    fn uv(&self, shares: [f64; 2]) -> [f64; 2] {
        [0, 1].map(|k| {
            self.uvs[0][k]
                + shares[0] * (self.uvs[1][k] - self.uvs[0][k])
                + shares[1] * (self.uvs[2][k] - self.uvs[0][k])
        })
    }

    /// The place on the surface nearest `target` that a few steps from the place with `shares` of the corners
    /// reach, and how far the surface is from `target` there. Each step moves by what the triangle's corners say a
    /// move across the surface takes, and never out of the triangle, so the place is one of the face as long as
    /// the triangle's own stretch of the surface is. Stops once within `enough`, or after `steps`.
    fn toward(
        &self,
        face: FaceRef<'_>,
        target: [f64; 3],
        shares: [f64; 2],
        (enough, steps): (f64, usize),
    ) -> ([f64; 2], f64) {
        let [start, second, third] = self.points;
        let (along, across) = (sub(second, start), sub(third, start));
        let (aa, ab, bb) = (dot(along, along), dot(along, across), dot(across, across));
        let det = aa * bb - ab * ab;
        let mut shares = shares;
        let (mut best, mut least) = (self.uv(shares), f64::INFINITY);
        for step in 0..=steps {
            let uv = self.uv(shares);
            let Ok((on, _)) = face.at(uv) else { break };
            let off = sub(target, on.into());
            let far = dot(off, off).sqrt();
            if far < least {
                (best, least) = (uv, far);
            }
            if least <= enough || step == steps || det <= 0.0 || det.is_nan() {
                break;
            }
            let (to_along, to_across) = (dot(off, along), dot(off, across));
            let moved = [
                (shares[0] + (to_along * bb - to_across * ab) / det).max(0.0),
                (shares[1] + (to_across * aa - to_along * ab) / det).max(0.0),
            ];
            let all = (moved[0] + moved[1]).max(1.0);
            shares = [moved[0] / all, moved[1] / all];
        }
        (best, least)
    }
}

/// What a point of a flat triangle is measured against before the face's own closest point is asked.
#[derive(Clone, Copy)]
enum By {
    /// The surface's point at these shares of the triangle's corners.
    Place(Patch, [f64; 2]),
    /// The edges of the body between these two faces, for the middle of a side on the face's outline.
    Edges(Side),
    /// Nothing.
    Solve,
}

/// What splitting a mesh keeps from one round to the next.
struct Splitting<'a, 's> {
    faces: &'a [FaceRef<'s>],
    edges: &'a [EdgeRef<'s>],
    /// The two faces of each edge.
    joined: &'a [[u32; 2]],
    /// The edges between each two faces, as places in `edges`.
    between: HashMap<Side, Vec<usize>>,
    /// Faces that are planes: a triangle of one is in it, so they are not measured.
    flat: Vec<bool>,
    chord: f64,
    /// Which way the kernel's surface normal points on each face against the normals its mesh stores: 1 or -1.
    outward: HashMap<u32, f64>,
    next_record: u32,
    /// For each triangle of the mesh, whether it was measured within the chord and has not been cut since. Empty
    /// before the first round.
    settled: Vec<bool>,
    /// How many places have been measured.
    measured: usize,
    /// How many times a face has been asked for its closest point.
    solved: Cell<usize>,
    /// The farthest a triangle was found from its face in the last round that found one past the chord.
    farthest: f64,
}

impl<'s> Splitting<'_, 's> {
    fn face(&self, face: u32) -> Result<FaceRef<'s>> {
        self.faces.get(face as usize).copied().ok_or(Error::Mesh {
            why: "a triangle of no face".to_owned(),
        })
    }

    /// How far `at`, a point of a flat triangle, is from the triangle's face, when that is more than the chord.
    /// Two measures, each the distance to a real point of the face and so never less than the face's. The first is
    /// `by`: the surface's point at the shares of the triangle's corners `at` has, brought nearer in a few steps,
    /// or for the middle of a side on the face's outline the nearest point of the body's edges there, which are the
    /// face's own. When that is past the chord the face's own closest point is asked. The smaller counts. Neither
    /// is enough alone: where a face narrows to a point a corner's place is not a real one and the surface's point
    /// stays far however small the triangle, and on a body thinner than the chord the closest point can be one of
    /// the far side.
    fn over(&self, face: FaceRef<'_>, at: [f64; 3], by: By) -> Result<Option<f64>> {
        let bound = match by {
            By::Place(patch, shares) => patch.toward(face, at, shares, (self.chord, BOUND_STEPS)).1,
            By::Edges(pair) => {
                let mut least = f64::INFINITY;
                for &edge in self.between.get(&pair).map_or(&[][..], Vec::as_slice) {
                    least = least.min(self.edges[edge].nearest(at.into())?.1);
                }
                least
            }
            By::Solve => f64::INFINITY,
        };
        if bound <= self.chord {
            return Ok(None);
        }
        self.solved.set(self.solved.get() + 1);
        // each is the distance from `at` to a point that lies on the face, so each is an upper bound on the true
        // distance, and so is the smaller of them
        let far = face.distance_to(at.into())?.min(bound);
        // a distance that is not a number is past the chord too
        Ok(if far <= self.chord { None } else { Some(far) })
    }

    /// The sides of every triangle that is more than the chord from its face at its middle or at the middle of a
    /// side, and the farthest any is.
    fn past_chord(&mut self, mesh: &Polygons) -> Result<(HashSet<Side>, f64)> {
        let mut marked: HashSet<Side> = HashSet::new();
        let mut worst = 0.0_f64;
        let (inside, beside) = side_users(mesh);
        for (triangle, ((corners, &on), uvs)) in
            mesh.triangles.iter().zip(&mesh.faces).zip(&mesh.uvs).enumerate()
        {
            let settled = self.settled.get(triangle).copied().unwrap_or(false);
            if settled || self.flat.get(on as usize).copied().unwrap_or(false) {
                continue;
            }
            let face = self.face(on)?;
            let [pa, pb, pc] = corners.map(|vertex| point(mesh, vertex));
            let patch = match *uvs {
                [Some(ua), Some(ub), Some(uc)] => Some(Patch::new([pa, pb, pc], [ua, ub, uc])),
                _ => None,
            };
            // inside the face a side is measured like the middle, by the surface between its ends. On the face's
            // outline that can lie outside the outline, so the side is measured by the body's edges there
            let by = |k: usize, shares: [f64; 2]| {
                let of = side(corners[k], corners[(k + 1) % 3]);
                if inside.get(&(of, on)).is_some_and(|&users| users == 2) {
                    patch.map_or(By::Solve, |patch| By::Place(patch, shares))
                } else {
                    let other = beside
                        .get(&of)
                        .and_then(|faces| faces.iter().find(|&&face| face != on));
                    other.map_or(By::Solve, |&other| By::Edges(side(on, other)))
                }
            };
            let mut far: Option<f64> = None;
            for (at, by) in [
                (
                    mean([pa, pb, pc]),
                    patch.map_or(By::Solve, |patch| By::Place(patch, [1.0 / 3.0, 1.0 / 3.0])),
                ),
                (mean([pa, pb]), by(0, [0.5, 0.0])),
                (mean([pb, pc]), by(1, [0.5, 0.5])),
                (mean([pc, pa]), by(2, [0.0, 0.5])),
            ] {
                if let Some(off) = self.over(face, at, by)? {
                    far = Some(far.map_or(off, |most| most.max(off)));
                }
            }
            self.measured += 4;
            if self.measured > REFINE_SAMPLES || self.solved.get() > REFINE_SOLVES {
                return Err(coarse(
                    worst.max(far.unwrap_or(0.0)).max(self.farthest),
                    self.chord,
                ));
            }
            if let Some(far) = far {
                worst = if far.is_nan() {
                    f64::INFINITY
                } else {
                    worst.max(far)
                };
                for k in 0..3 {
                    marked.insert(side(corners[k], corners[(k + 1) % 3]));
                }
            }
        }
        if worst > 0.0 {
            self.farthest = worst;
        }
        Ok((marked, worst))
    }

    /// Whether a side lies within one face, and not on an edge of the body: both its triangles are of that face,
    /// and they share the kernel's record at an end of it, which the two sides of a seam (where a face meets
    /// itself) do not, or the face has no seam.
    fn inside(&self, mesh: &Polygons, of: Side, on: &[usize], lower: Corner, upper: Corner) -> bool {
        let &[first, second] = on else { return false };
        let face = mesh.faces[first];
        if face != mesh.faces[second] {
            return false;
        }
        let shared =
            ends(mesh, second, of).is_some_and(|[a, b]| a.record == lower.record || b.record == upper.record);
        shared || !self.joined.contains(&[face, face])
    }

    /// The point of the body's edges nearest `near`, of the edges between the two faces the triangles in `on` are
    /// of when there are two triangles. Both faces along an edge get this one point.
    fn on_an_edge(&self, mesh: &Polygons, on: &[usize], near: [f64; 3]) -> Result<[f64; 3]> {
        let between = match on {
            [first, second] => Some(side(mesh.faces[*first], mesh.faces[*second])),
            _ => None,
        };
        let all: Vec<usize>;
        let among: &[usize] = if let Some(pair) = between {
            self.between.get(&pair).map_or(&[][..], Vec::as_slice)
        } else {
            all = (0..self.edges.len()).collect();
            &all
        };
        let mut nearest: Option<(f64, [f64; 3])> = None;
        for &edge in among {
            let (closest, far) = self.edges[edge].nearest(near.into())?;
            if nearest.is_none_or(|(least, _)| far < least) {
                nearest = Some((far, closest.into()));
            }
        }
        Ok(nearest.map_or(near, |(_, closest)| closest))
    }

    /// Which way the surface's own normal points on a face against the normals the mesh stores there, read at
    /// the ends of a side: 1 the same way, -1 the other, none when the mesh stores no normal to tell by.
    fn turn(&mut self, face: u32, at: [Corner; 2]) -> Result<Option<f64>> {
        if let Some(turn) = self.outward.get(&face) {
            return Ok(Some(*turn));
        }
        let surface = self.face(face)?;
        for end in at {
            let (Some(stored), Some(uv)) = (end.normal, end.uv) else {
                continue;
            };
            let Ok((_, Some(own))) = surface.at(uv) else {
                continue;
            };
            let own: [f64; 3] = own.into();
            let along = dot(own, stored.into());
            if along.abs() > 0.5 {
                self.outward.insert(face, along.signum());
                return Ok(Some(along.signum()));
            }
        }
        Ok(None)
    }

    /// A new point in the middle of every marked side, and the corner each triangle on the side gets there. A
    /// side inside a face gets the surface's point halfway between its ends in the surface's own parameters; a
    /// side on an edge of the body gets the nearest point of the edge's curve. Sides are taken in order, so the
    /// same body gives the same mesh.
    fn middles(&mut self, mesh: &mut Polygons, marked: &HashSet<Side>) -> Result<HashMap<Place, Corner>> {
        let mut users: HashMap<Side, Vec<usize>> = HashMap::new();
        for (triangle, corners) in mesh.triangles.iter().enumerate() {
            for k in 0..3 {
                let of = side(corners[k], corners[(k + 1) % 3]);
                if marked.contains(&of) {
                    users.entry(of).or_default().push(triangle);
                }
            }
        }
        let mut order: Vec<Side> = marked.iter().copied().collect();
        order.sort_unstable();
        let mut corners: HashMap<Place, Corner> = HashMap::new();
        for of in order {
            let on = users.get(&of).map_or(&[][..], Vec::as_slice);
            let Some(&first) = on.first() else { continue };
            let Some([lower, upper]) = ends(mesh, first, of) else {
                continue;
            };
            let straight = mean([point(mesh, of.0), point(mesh, of.1)]);
            let inside = self.inside(mesh, of, on, lower, upper);
            let place: [f64; 3] = if inside {
                // the surface's point at the middle of the side as its first triangle has it, never a nearest
                // point, which on a thin body can be one of the far side
                let face = self.face(mesh.faces[first])?;
                let all = [0, 1, 2].map(|k| corner(mesh, first, k));
                let there = Patch::of(all, mesh).and_then(|patch| face.at(patch.uv(middle_of(all, of))).ok());
                match there {
                    Some((on, _)) => on.into(),
                    None => face.nearest(straight.into())?.0.into(),
                }
            } else {
                self.on_an_edge(mesh, on, straight)?
            };
            let vertex = u32::try_from(mesh.positions.len()).map_err(|_| Error::Mesh {
                why: "too many points".to_owned(),
            })?;
            mesh.positions.push(place.into());
            for &triangle in on {
                let Some([lower, upper]) = ends(mesh, triangle, of) else {
                    continue;
                };
                let face = mesh.faces[triangle];
                let key = (of, face, lower.record, upper.record);
                if corners.contains_key(&key) {
                    continue;
                }
                let surface = self.face(face)?;
                // where the new point is on the surface as this triangle sees it: from the middle of the side,
                // brought to the point. Triangles that meet at a pole, or on the two sides of a seam, see the same
                // point at different places
                let all = [0, 1, 2].map(|k| corner(mesh, triangle, k));
                let near = match Patch::of(all, mesh) {
                    Some(patch) => {
                        patch
                            .toward(surface, place, middle_of(all, of), (PLACED_MM, PLACE_STEPS))
                            .0
                    }
                    None => surface.nearest(place.into())?.1,
                };
                // along an edge of the body a parameter the two ends share is the edge's own there
                let uv = match lower.uv.zip(upper.uv) {
                    Some((from, to)) if !inside => [0, 1].map(|k| {
                        if from[k].total_cmp(&to[k]).is_eq() {
                            from[k]
                        } else {
                            near[k]
                        }
                    }),
                    _ => near,
                };
                // the surface's own normal there, turned to the side the mesh's stored normals are on
                let normal = self.turn(face, [lower, upper])?.and_then(|turn| {
                    if let Some(own) = surface.at(uv).ok().and_then(|(_, own)| own) {
                        let own: [f64; 3] = own.into();
                        Some(own.map(|c| c * turn).into())
                    } else {
                        // where the surface has no normal, the one between those the kernel stored at the ends
                        let (from, to): ([f64; 3], [f64; 3]) = (lower.normal?.into(), upper.normal?.into());
                        let sum = [0, 1, 2].map(|k| from[k] + to[k]);
                        let length = dot(sum, sum).sqrt();
                        (length > 0.5).then(|| sum.map(|c| c / length).into())
                    }
                });
                let record = Some(self.next_record);
                self.next_record += 1;
                corners.insert(
                    key,
                    Corner {
                        vertex,
                        normal,
                        record,
                        uv: Some(uv),
                    },
                );
            }
        }
        Ok(corners)
    }
}

/// For each side of a mesh: how many triangles of one face are on it, two inside the face; and the faces of the
/// triangles on it, which are two different ones on an edge of the body.
type Sides = (HashMap<(Side, u32), u8>, HashMap<Side, Vec<u32>>);

fn side_users(mesh: &Polygons) -> Sides {
    let mut inside: HashMap<(Side, u32), u8> = HashMap::new();
    let mut beside: HashMap<Side, Vec<u32>> = HashMap::new();
    for (corners, &on) in mesh.triangles.iter().zip(&mesh.faces) {
        for k in 0..3 {
            let of = side(corners[k], corners[(k + 1) % 3]);
            let users = inside.entry((of, on)).or_default();
            *users = users.saturating_add(1);
            let faces = beside.entry(of).or_default();
            if !faces.contains(&on) {
                faces.push(on);
            }
        }
    }
    (inside, beside)
}

/// The shares of a triangle's second and third corners that the middle of its side `of` has.
fn middle_of(all: [Corner; 3], of: Side) -> [f64; 2] {
    let half = |k: usize| {
        if all[k].vertex == of.0 || all[k].vertex == of.1 {
            0.5
        } else {
            0.0
        }
    };
    [half(1), half(2)]
}

/// A triangle cut along the new points on its sides: `new[k]` is the one between corner `k` and the next. One new
/// point makes two triangles, two make three and three make four, all wound as the triangle was.
fn cut(old: [Corner; 3], new: [Option<Corner>; 3]) -> Vec<[Corner; 3]> {
    match new {
        [None, None, None] => vec![old],
        [Some(ab), Some(bc), Some(ca)] => {
            vec![[old[0], ab, ca], [ab, old[1], bc], [ca, bc, old[2]], [ab, bc, ca]]
        }
        _ => {
            // turned so that the sides after the first corner hold the new points
            let first = (0..3)
                .find(|&k| new[k].is_some() && new[(k + 2) % 3].is_none())
                .unwrap_or(0);
            let (start, next, last) = (old[first], old[(first + 1) % 3], old[(first + 2) % 3]);
            match (new[first], new[(first + 1) % 3]) {
                (Some(one), Some(two)) => vec![[one, next, two], [start, one, two], [start, two, last]],
                (Some(one), None) => vec![[start, one, last], [one, next, last]],
                _ => vec![old],
            }
        }
    }
}

/// The mesh with every triangle cut along the new points of its sides, and for each of its triangles whether it is
/// one that was not cut. None when a face would come to more than [`REFINE_FACE_TRIANGLES`].
fn split(mesh: &mut Polygons, new: &HashMap<Place, Corner>) -> Option<(Polygons, Vec<bool>)> {
    let mut out = Polygons {
        positions: std::mem::take(&mut mesh.positions),
        ..Polygons::default()
    };
    let mut count: HashMap<u32, usize> = HashMap::new();
    let mut whole = Vec::with_capacity(mesh.triangles.len());
    for (triangle, &face) in mesh.faces.iter().enumerate() {
        let old = [0, 1, 2].map(|k| corner(mesh, triangle, k));
        let parts = cut(
            old,
            [0, 1, 2].map(|k| {
                let (from, to) = (old[k], old[(k + 1) % 3]);
                let (lower, upper) = if from.vertex <= to.vertex {
                    (from, to)
                } else {
                    (to, from)
                };
                new.get(&(side(from.vertex, to.vertex), face, lower.record, upper.record))
                    .copied()
            }),
        );
        let made = count.entry(face).or_default();
        *made += parts.len();
        if *made > REFINE_FACE_TRIANGLES {
            return None;
        }
        let uncut = parts.len() == 1;
        for part in parts {
            whole.push(uncut);
            out.triangles.push(part.map(|k| k.vertex));
            out.faces.push(face);
            out.normals.push(part.map(|k| k.normal));
            out.records.push(part.map(|k| k.record));
            out.uvs.push(part.map(|k| k.uv));
        }
    }
    Some((out, whole))
}

/// Read back of a tessellation: every triangle's middle and the middle of each of its sides is within `chord` of
/// the triangle's own face, by the kernel's own surface. The kernel does not always hold the chord it is asked
/// for (a spline face that narrows to a point comes back five times too coarse), so triangles past it are split
/// here, each new point put on the surface, or on the edge's curve where the side lies on an edge of the body so
/// that both faces there get the same point, until all are within it. A mesh that already holds the chord is left
/// exactly as it is. Past [`REFINE_ROUNDS`], [`REFINE_FACE_TRIANGLES`], [`REFINE_SAMPLES`] or [`REFINE_SOLVES`] it
/// is refused: no mesh that misses the chord is handed back. `joined` has the two faces of each
/// edge.
pub(crate) fn held_to_chord(
    faces: &[FaceRef<'_>],
    edges: &[EdgeRef<'_>],
    joined: &[[u32; 2]],
    mesh: &mut Polygons,
    chord: f64,
) -> Result<()> {
    let mut between: HashMap<Side, Vec<usize>> = HashMap::new();
    for (edge, faces) in joined.iter().enumerate() {
        between.entry(side(faces[0], faces[1])).or_default().push(edge);
    }
    let mut splitting = Splitting {
        faces,
        edges,
        joined,
        between,
        flat: faces
            .iter()
            .map(|face| matches!(face.shape(), Shape::Plane(_)))
            .collect(),
        chord,
        outward: HashMap::new(),
        next_record: mesh.records.iter().flatten().flatten().max().map_or(0, |r| r + 1),
        settled: Vec::new(),
        measured: 0,
        solved: Cell::new(0),
        farthest: 0.0,
    };
    for round in 0..=REFINE_ROUNDS {
        let (marked, worst) = splitting.past_chord(mesh)?;
        if marked.is_empty() {
            return Ok(());
        }
        if round == REFINE_ROUNDS {
            return Err(coarse(worst, chord));
        }
        let new = splitting.middles(mesh, &marked)?;
        // a triangle that was not cut was measured within the chord, or is of a plane
        (*mesh, splitting.settled) = split(mesh, &new).ok_or_else(|| coarse(worst, chord))?;
    }
    Ok(())
}
