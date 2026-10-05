// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The inward offset the travel planner's boundary uses: the layer's slice pulled in by a
//! distance everywhere except where the part is thin, so a narrow tooth or web keeps a
//! boundary of its own instead of vanishing.
//!
//! Orca's counterpart is `inner_offset` in `src/libslic3r/GCode/AvoidCrossingPerimeters.cpp`,
//! with `resample_polygon`, `contour_distance` and `variable_offset_inner_ex`. The steps: holes
//! narrower than 0.2 mm are dropped; points are added a little way from every vertex and at
//! most 0.5 mm apart along long edges; each point measures how far the opposite side of the
//! part is; it moves in by nothing where the part is thinner than a minimum width, by the full
//! distance where it is more than that width plus twice the distance wide, and in between by
//! half the excess; the moved rings are merged. Three minimum widths are tried, and the
//! first result that stays one piece with the same holes wins.

use crate::fm::Fm as _;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

type Pt = [f64; 2];

struct Ring {
    pts: Vec<Pt>,
}

fn dist(a: Pt, b: Pt) -> f64 {
    (a[0] - b[0]).m_hypot(a[1] - b[1])
}

fn area2(pts: &[Pt]) -> f64 {
    let n = pts.len();
    (0..n)
        .map(|i| match (pts.get(i), pts.get((i + 1) % n)) {
            (Some(a), Some(b)) => a[0] * b[1] - b[0] * a[1],
            _ => 0.0,
        })
        .sum()
}

/// Rings of one island with the material on the left: the contour counterclockwise, holes clockwise.
fn oriented(island: &[Vec<IntPoint<i32>>]) -> Vec<Ring> {
    island
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let mut pts: Vec<Pt> = c
                .iter()
                .map(|p| {
                    [
                        f64::from(p.x) / crate::geom::SCALE,
                        f64::from(p.y) / crate::geom::SCALE,
                    ]
                })
                .collect();
            if (area2(&pts) > 0.0) != (i == 0) {
                pts.reverse();
            }
            Ring { pts }
        })
        .collect()
}

/// Adds points near every vertex and along long edges (`resample_polygon`).
fn resample(ring: &Ring, from_vertex: f64, max_gap: f64) -> Ring {
    let n = ring.pts.len();
    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n {
        let (Some(&p1), Some(&p2)) = (ring.pts.get(i), ring.pts.get((i + 1) % n)) else {
            continue;
        };
        out.push(p1);
        let len = dist(p1, p2);
        if len > 2.0 * from_vertex && from_vertex > 0.0 {
            let u = [(p2[0] - p1[0]) / len, (p2[1] - p1[1]) / len];
            let a = [p1[0] + u[0] * from_vertex, p1[1] + u[1] * from_vertex];
            out.push(a);
            let span = len - 2.0 * from_vertex;
            if span > max_gap {
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a part count"
                )]
                let parts = (span / max_gap).ceil() as usize;
                for k in 1..parts {
                    #[allow(clippy::cast_precision_loss, reason = "a part count")]
                    let f = k as f64 / parts as f64;
                    out.push([a[0] + u[0] * span * f, a[1] + u[1] * span * f]);
                }
            }
            out.push([p2[0] - u[0] * from_vertex, p2[1] - u[1] * from_vertex]);
        }
    }
    Ring { pts: out }
}

/// Direction into the material at a point (not normalized): the left normal of the two edges at it.
fn dir_inside(ring: &Ring, i: usize) -> Pt {
    let n = ring.pts.len();
    let (Some(&a), Some(&m), Some(&b)) = (
        ring.pts.get((i + n - 1) % n),
        ring.pts.get(i),
        ring.pts.get((i + 1) % n),
    ) else {
        return [0.0, 0.0];
    };
    let (v1, v2) = ([m[0] - a[0], m[1] - a[1]], [b[0] - m[0], b[1] - m[1]]);
    [-v1[1] - v2[1], v1[0] + v2[0]]
}

fn cross(a: Pt, b: Pt) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

/// The segments of every ring binned by a square grid, so a point finds the segments near it without
/// scanning them all. A segment sits in each cell its bounding box touches.
struct Grid {
    origin: Pt,
    cell: f64,
    nx: usize,
    ny: usize,
    /// Cell `c` holds `segs[start[c]..start[c + 1]]`, each `(ring, index of its first point)`.
    start: Vec<u32>,
    segs: Vec<(u32, u32)>,
}

impl Grid {
    fn new(rings: &[Ring], cell: f64) -> Self {
        let (lo, hi) = rings
            .iter()
            .flat_map(|r| r.pts.iter())
            .fold(([f64::MAX; 2], [f64::MIN; 2]), |(l, h), p| {
                ([l[0].min(p[0]), l[1].min(p[1])], [h[0].max(p[0]), h[1].max(p[1])])
            });
        let cell = if cell > 0.0 && cell.is_finite() { cell } else { 1.0 };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "cell counts of a bounded part"
        )]
        let span = |a: f64, b: f64| (((b - a) / cell).floor().max(0.0) as usize + 1).min(4096);
        let (nx, ny) = if lo[0] <= hi[0] {
            (span(lo[0], hi[0]), span(lo[1], hi[1]))
        } else {
            (1, 1)
        };
        let mut g = Self {
            origin: lo,
            cell,
            nx,
            ny,
            start: vec![0; nx * ny + 1],
            segs: Vec::new(),
        };
        let boxes: Vec<(u32, u32, [usize; 4])> = rings
            .iter()
            .enumerate()
            .flat_map(|(ri, r)| {
                let n = r.pts.len();
                let g = &g;
                (0..n).filter_map(move |j| {
                    let (a, b) = (*r.pts.get(j)?, *r.pts.get((j + 1) % n)?);
                    let (x0, y0) = g.at([a[0].min(b[0]), a[1].min(b[1])]);
                    let (x1, y1) = g.at([a[0].max(b[0]), a[1].max(b[1])]);
                    #[allow(clippy::cast_possible_truncation, reason = "ring and point counts fit u32")]
                    Some((ri as u32, j as u32, [x0, y0, x1, y1]))
                })
            })
            .collect();
        for &(_, _, [x0, y0, x1, y1]) in &boxes {
            for y in y0..=y1 {
                for x in x0..=x1 {
                    if let Some(c) = g.start.get_mut(y * nx + x + 1) {
                        *c += 1;
                    }
                }
            }
        }
        for c in 1..g.start.len() {
            let prev = g.start.get(c - 1).copied().unwrap_or(0);
            if let Some(v) = g.start.get_mut(c) {
                *v += prev;
            }
        }
        let mut fill = g.start.clone();
        g.segs = vec![(0, 0); g.start.last().copied().unwrap_or(0) as usize];
        for &(ri, j, [x0, y0, x1, y1]) in &boxes {
            for y in y0..=y1 {
                for x in x0..=x1 {
                    if let Some(f) = fill.get_mut(y * nx + x) {
                        if let Some(slot) = g.segs.get_mut(*f as usize) {
                            *slot = (ri, j);
                        }
                        *f += 1;
                    }
                }
            }
        }
        g
    }

    /// The cell of a point, clamped to the grid.
    fn at(&self, p: Pt) -> (usize, usize) {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "clamped to the grid"
        )]
        let f = |v: f64, o: f64, n: usize| (((v - o) / self.cell).floor().max(0.0) as usize).min(n - 1);
        (f(p[0], self.origin[0], self.nx), f(p[1], self.origin[1], self.ny))
    }

    /// Calls `f` with every segment whose bounding box may lie within `r` of `p` (some more than once).
    fn near(&self, p: Pt, r: f64, mut f: impl FnMut(usize, usize)) {
        // A micron of slack keeps rounding at the cell edges from losing a segment.
        let r = r + 1e-3;
        let (x0, y0) = self.at([p[0] - r, p[1] - r]);
        let (x1, y1) = self.at([p[0] + r, p[1] + r]);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let c = y * self.nx + x;
                let (Some(&s), Some(&e)) = (self.start.get(c), self.start.get(c + 1)) else {
                    continue;
                };
                for &(ri, j) in self.segs.get(s as usize..e as usize).unwrap_or(&[]) {
                    f(ri as usize, j as usize);
                }
            }
        }
    }
}

/// How far the part extends from point `i` of ring `ri` to the opposite side, at most `radius` (`contour_distance`).
/// The answer is the shortest accepted distance, which does not depend on the order segments are visited in, so
/// only the segments the grid finds near the point are tried. Returns it with the shortest accepted distance itself,
/// when there is one below `radius`: a larger radius accepts the same distances below this one (the rule
/// changes only at the radius), so that distance is the answer for every larger radius too.
fn width_at(
    rings: &[Ring],
    lengths: &[Vec<f64>],
    grid: &Grid,
    ri: usize,
    i: usize,
    compensation: f64,
    radius: f64,
) -> (f64, Option<f64>) {
    let Some(ring) = rings.get(ri) else {
        return (radius, None);
    };
    let Some(&p) = ring.pts.get(i) else {
        return (radius, None);
    };
    let inward = dir_inside(ring, i);
    let accept_along = 0.5 * compensation * std::f64::consts::PI;
    let mut best: Option<f64> = None;
    grid.near(p, radius, |rj, j| {
        let Some(other) = rings.get(rj) else { return };
        let n = other.pts.len();
        let (Some(&a), Some(&b)) = (other.pts.get(j), other.pts.get((j + 1) % n)) else {
            return;
        };
        let v = [b[0] - a[0], b[1] - a[1]];
        let l2 = v[0] * v[0] + v[1] * v[1];
        let t = if l2 == 0.0 {
            0.0
        } else {
            (((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / l2).clamp(0.0, 1.0)
        };
        let foot = [a[0] + t * v[0], a[1] + t * v[1]];
        let bis = [foot[0] - p[0], foot[1] - p[1]];
        if inward[0] * bis[0] + inward[1] * bis[1] <= 0.0 {
            return;
        }
        // The squared length rules out far feet before the exact length is taken; the slack covers its rounding.
        let d2 = bis[0] * bis[0] + bis[1] * bis[1];
        let cap = best.map_or(radius, |b| b.min(radius)) * (1.0 + 1e-9);
        if d2 > cap * cap {
            return;
        }
        let d = bis[0].m_hypot(bis[1]);
        if d > radius || !(best.is_none_or(|b| d < b)) || inward[0] * bis[0] + inward[1] * bis[1] <= 0.0 {
            return;
        }
        let mut accept = true;
        if rj == ri {
            let cum = lengths.get(ri);
            let total = cum.and_then(|c| c.last().copied()).unwrap_or(0.0);
            let mut lo = cum.and_then(|c| c.get(i).copied()).unwrap_or(0.0);
            let mut hi = t * l2.sqrt() + cum.and_then(|c| c.get(j).copied()).unwrap_or(0.0);
            if lo > hi {
                std::mem::swap(&mut lo, &mut hi);
            }
            let along = (hi - lo).min(lo + total - hi);
            if along < accept_along {
                accept = false;
            } else if d < radius {
                // Close to the foot along a long way round: only on an inside corner, and a bulge must be wide enough.
                let prev = other.pts.get((j + n - 1) % n).copied().unwrap_or(a);
                let inside = if t == 0.0 {
                    let (v1, v2) = ([a[0] - prev[0], a[1] - prev[1]], [b[0] - a[0], b[1] - a[1]]);
                    let (l1, l2c) = (
                        cross(v1, [p[0] - prev[0], p[1] - prev[1]]) > 0.0,
                        cross(v2, [p[0] - a[0], p[1] - a[1]]) > 0.0,
                    );
                    if cross(v1, v2) > 0.0 { l1 && l2c } else { l1 || l2c }
                } else {
                    cross(v, [p[0] - a[0], p[1] - a[1]]) > 0.0
                };
                accept = inside && along > 0.6 * std::f64::consts::PI * d;
            }
        }
        if accept {
            best = Some(d);
        }
    });
    (
        best.map_or(radius, |d| d.min(radius)),
        best.filter(|&d| d < radius),
    )
}

fn to_shapes(rings: &[Ring]) -> Shapes {
    let shape: Vec<Vec<IntPoint<i32>>> = rings
        .iter()
        .filter(|r| r.pts.len() >= 3)
        .map(|r| {
            r.pts
                .iter()
                .map(|p| IntPoint::new(crate::geom::mm(p[0]), crate::geom::mm(p[1])))
                .collect()
        })
        .collect();
    if shape.is_empty() {
        return Vec::new();
    }
    perimeters::union_all(&[&vec![shape]])
}

/// One island pulled in by `offset` mm with the variable rule, or None when nothing is left.
fn island(rings: &[Ring], offset: f64) -> Option<Shapes> {
    // Holes narrower than 0.2 mm are closed.
    let rings: Vec<Ring> = rings
        .iter()
        .enumerate()
        .filter(|(i, r)| {
            *i == 0 || {
                let (lo, hi) = r.pts.iter().fold(([f64::MAX; 2], [f64::MIN; 2]), |(l, h), p| {
                    ([l[0].min(p[0]), l[1].min(p[1])], [h[0].max(p[0]), h[1].max(p[1])])
                });
                (hi[0] - lo[0]).min(hi[1] - lo[1]) >= 0.2
            }
        })
        .map(|(_, r)| Ring { pts: r.pts.clone() })
        .collect();
    let rings: Vec<Ring> = rings.iter().map(|r| resample(r, offset / 2.0, 0.5)).collect();
    let (lo, hi) = rings
        .first()?
        .pts
        .iter()
        .fold(([f64::MAX; 2], [f64::MIN; 2]), |(l, h), p| {
            ([l[0].min(p[0]), l[1].min(p[1])], [h[0].max(p[0]), h[1].max(p[1])])
        });
    if (hi[0] - lo[0]) * (hi[1] - lo[1]) < 0.01 {
        return None;
    }
    let lengths: Vec<Vec<f64>> = rings
        .iter()
        .map(|r| {
            let n = r.pts.len();
            let mut cum = vec![0.0];
            for i in 0..n {
                let d = match (r.pts.get(i), r.pts.get((i + 1) % n)) {
                    (Some(&a), Some(&b)) => dist(a, b),
                    _ => 0.0,
                };
                cum.push(cum.last().copied().unwrap_or(0.0) + d);
            }
            cum
        })
        .collect();
    let widths = [offset / 2.0, offset, 2.0 * offset + 0.0001];
    let grid = Grid::new(&rings, 1.5 * offset);
    // Per point, the width found below the last radius, which holds for the larger radii that follow.
    let mut known: Vec<Vec<Option<f64>>> = rings.iter().map(|r| vec![None; r.pts.len()]).collect();
    for (k, &min_width) in widths.iter().enumerate() {
        // Any width past `min_width + 2 offset` moves the point by the full offset, so the search stops a
        // hair beyond that instead of at Orca's `2 (offset + min_width)`: nearer feet are accepted the same way
        // either way, and a point with none comes out moved by the offset in both.
        let radius = (min_width + 2.0 * offset) * (1.0 + 1e-9) + 1e-9;
        let moved: Vec<Ring> = rings
            .iter()
            .enumerate()
            .map(|(ri, r)| Ring {
                pts: (0..r.pts.len())
                    .filter_map(|i| {
                        let slot = known.get_mut(ri).and_then(|v| v.get_mut(i));
                        let w = match slot {
                            Some(Some(d)) => *d,
                            Some(slot) => {
                                let (w, below) = width_at(&rings, &lengths, &grid, ri, i, offset, radius);
                                *slot = below;
                                w
                            }
                            None => width_at(&rings, &lengths, &grid, ri, i, offset, radius).0,
                        };
                        let inset = if w < min_width {
                            0.0
                        } else if w > min_width + 2.0 * offset {
                            offset
                        } else {
                            (w - min_width) / 2.0
                        };
                        let p = r.pts.get(i).copied()?;
                        let dir = dir_inside(r, i);
                        let l = dir[0].m_hypot(dir[1]);
                        // A miter: the corner moves further along its bisector so both edges move by `inset`.
                        let n = r.pts.len();
                        let a = r.pts.get((i + n - 1) % n).copied()?;
                        let e1 = [p[0] - a[0], p[1] - a[1]];
                        let l1 = e1[0].m_hypot(e1[1]).max(1e-12);
                        let n1 = [-e1[1] / l1, e1[0] / l1];
                        let cos_half = ((n1[0] * dir[0] + n1[1] * dir[1]) / l.max(1e-12)).max(0.5);
                        (l > 1e-12).then(|| {
                            [
                                p[0] + dir[0] / l * inset / cos_half,
                                p[1] + dir[1] / l * inset / cos_half,
                            ]
                        })
                    })
                    .collect(),
            })
            .collect();
        let out = to_shapes(&moved);
        let holes = rings.len() - 1;
        if out.len() == 1 && out.first().is_some_and(|s| s.len() - 1 == holes) {
            return Some(out);
        }
        if k + 1 == widths.len() {
            // The largest piece, by the number of points as a cheap size.
            return out
                .into_iter()
                .max_by_key(|s| s.iter().map(Vec::len).sum::<usize>())
                .map(|s| vec![s]);
        }
    }
    None
}

/// The slice pulled in by `offset_mm`, island by island.
pub(crate) fn inner_offset(slice: &Shapes, offset_mm: f64) -> Shapes {
    let mut out: Shapes = Vec::new();
    for shape in slice {
        if let Some(o) = island(&oriented(shape), offset_mm) {
            out.extend(o);
        }
    }
    perimeters::union_all(&[&out])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<IntPoint<i32>> {
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            .iter()
            .map(|&(x, y)| IntPoint::new(crate::geom::mm(x), crate::geom::mm(y)))
            .collect()
    }

    fn bounds(s: &Shapes) -> [f64; 4] {
        let b = perimeters::bounds(s).unwrap();
        b.map(|v| f64::from(v) / crate::geom::SCALE)
    }

    #[test]
    fn a_wide_part_is_pulled_in_by_the_distance() {
        let s: Shapes = vec![vec![rect(0.0, 0.0, 30.0, 30.0)]];
        let o = inner_offset(&s, 0.6);
        let b = bounds(&o);
        assert!((b[0] - 0.6).abs() < 0.05 && (b[2] - 29.4).abs() < 0.05, "{b:?}");
    }

    #[test]
    fn a_thin_strip_keeps_its_outline_instead_of_vanishing() {
        let s: Shapes = vec![vec![rect(0.0, 0.0, 30.0, 0.5)]];
        let o = inner_offset(&s, 0.63);
        assert!(!o.is_empty(), "the strip survives");
        let b = bounds(&o);
        assert!(b[2] - b[0] > 29.0, "{b:?}");
        // The plain offset would have removed it.
        assert!(perimeters::offset(&s, -crate::geom::mm(0.63)).is_empty());
    }

    #[test]
    fn a_hole_is_kept_and_grows() {
        let mut hole = rect(10.0, 10.0, 20.0, 20.0);
        hole.reverse();
        let s: Shapes = vec![vec![rect(0.0, 0.0, 30.0, 30.0), hole]];
        let o = inner_offset(&s, 0.6);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].len(), 2, "contour and hole");
    }

    #[test]
    fn tiny_holes_are_closed() {
        let mut hole = rect(10.0, 10.0, 10.1, 10.1);
        hole.reverse();
        let s: Shapes = vec![vec![rect(0.0, 0.0, 30.0, 30.0), hole]];
        let o = inner_offset(&s, 0.6);
        assert_eq!(o[0].len(), 1);
    }
}
