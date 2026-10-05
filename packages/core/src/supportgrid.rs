// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The grid style of normal supports: support islands stretched to whole cells of a coarse grid, the way
//! Orca's `SupportGridPattern` (Support/SupportMaterial.cpp, with its anti-aliased rasterizer) does it.
//!
//! The islands and the part are turned by minus the support angle and drawn into a pixel grid whose
//! macro blocks are the grid cells: a pixel is set when the islands cover any of it. Inside each block the
//! set pixels then spread to their neighbors up to the part (the part's pixels shrunk by one, so the
//! spreading stops just short of it), which fills the cells the islands touch on their own side of a wall.
//! The pixels read back as a rectilinear outline, grown or shrunk a little, are trimmed by the part again,
//! and only the pieces that hold a sample of the original islands are kept. The result is turned back.

use crate::fm::Fm as _;
use crate::geom::SCALE;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// A support area stretched to the grid, ready to be read back at any offset.
pub(crate) struct GridPattern {
    /// The islands and the part, turned into the grid frame.
    support: Shapes,
    trimming: Shapes,
    /// Pixel side, internal units, and the grid's lower left corner in the grid frame.
    pixel: f64,
    origin: (f64, f64),
    nx: usize,
    ny: usize,
    grid: Vec<u8>,
    angle_deg: f64,
    center: [f64; 2],
}

impl GridPattern {
    /// `support` (the islands) stretched to cells of `cell_mm`, trimmed by `trimming` (the part), for a
    /// support flow spacing of `spacing_mm`, with the grid turned by `angle_deg` about `center` (mm).
    pub(crate) fn new(
        support: &Shapes,
        trimming: &Shapes,
        cell_mm: f64,
        spacing_mm: f64,
        angle_deg: f64,
        center: [f64; 2],
    ) -> Option<Self> {
        let support = turn(support, -angle_deg, center);
        let trimming = turn(trimming, -angle_deg, center);
        let bounds = perimeters::bounds(&support)?;
        let cell = cell_mm * SCALE;
        // Oversampling: pixels a little wider than a support line, at most eight to a cell.
        #[allow(clippy::cast_possible_truncation, reason = "a small count")]
        let over = ((cell_mm / (spacing_mm + 1e-4)).floor() as i64).clamp(1, 8);
        #[allow(clippy::cast_precision_loss, reason = "a small count")]
        let pixel = (spacing_mm * SCALE + 0.21).max(cell / over as f64);
        // The box of the islands, its lower corner on the grid (relative to the center), one pixel of margin.
        let (cx, cy) = (center[0] * SCALE, center[1] * SCALE);
        let align = |v: f64, c: f64| c + ((v - c) / cell).floor() * cell;
        let min = (
            align(f64::from(bounds[0]), cx) - pixel,
            align(f64::from(bounds[1]), cy) - pixel,
        );
        let max = (f64::from(bounds[2]) + pixel, f64::from(bounds[3]) + pixel);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "grid sizes are small"
        )]
        let raw = (
            ((max.0 - min.0) / pixel).ceil() as i64,
            ((max.1 - min.1) / pixel).ceil() as i64,
        );
        let blocks = ((raw.0 + over - 3) / over, (raw.1 + over - 3) / over);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "grid sizes are small"
        )]
        let (nx, ny) = (
            (blocks.0 * over + 2).max(3) as usize,
            (blocks.1 * over + 2).max(3) as usize,
        );
        let mut grid = rasterize(&support, nx, ny, min, pixel);
        let mask = erode(&rasterize(&trimming, nx, ny, min, pixel), nx, ny);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "grid sizes are small"
        )]
        seed_fill_blocks(
            &mut grid,
            &mask,
            nx,
            (blocks.0.max(0) as usize, blocks.1.max(0) as usize),
            over as usize,
        );
        Some(Self {
            support,
            trimming,
            pixel,
            origin: min,
            nx,
            ny,
            grid,
            angle_deg,
            center,
        })
    }

    /// The stretched area grown by `offset` internal units (negative shrinks), less the part, keeping the
    /// pieces that hold a sample of the original islands. `fill_holes` first fills single empty pixels
    /// between two set ones.
    pub(crate) fn extract(&self, offset: i32, fill_holes: bool) -> Shapes {
        let (nx, ny) = (self.nx, self.ny);
        let at = |c: usize, r: usize| self.grid.get(r * nx + c).copied().unwrap_or(0) != 0;
        let mut cells = self.grid.clone();
        if fill_holes {
            for r in 1..ny.saturating_sub(1) {
                for c in 1..nx.saturating_sub(1) {
                    if ((at(c - 1, r) && at(c + 1, r)) || (at(c, r - 1) && at(c, r + 1)))
                        && let Some(v) = cells.get_mut(r * nx + c)
                    {
                        *v = 1;
                    }
                }
            }
        }
        // Rows of set pixels as rectangles; a positive offset grows each one (a miter offset of the outline).
        let grow = f64::from(offset.max(0));
        let mut rects: Shapes = Vec::new();
        for r in 0..ny {
            let mut c = 0;
            while c < nx {
                if cells.get(r * nx + c).copied().unwrap_or(0) == 0 {
                    c += 1;
                    continue;
                }
                let c0 = c;
                while c < nx && cells.get(r * nx + c).copied().unwrap_or(0) != 0 {
                    c += 1;
                }
                #[allow(clippy::cast_precision_loss, reason = "grid indexes are small")]
                let (x0, x1, y0, y1) = (
                    self.origin.0 + c0 as f64 * self.pixel - grow,
                    self.origin.0 + c as f64 * self.pixel + grow,
                    self.origin.1 + r as f64 * self.pixel - grow,
                    self.origin.1 + (r + 1) as f64 * self.pixel + grow,
                );
                rects.push(vec![vec![pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)]]);
            }
        }
        let mut area = perimeters::union_all(&[&rects]);
        if offset < 0 {
            area = perimeters::offset(&area, offset);
        }
        let islands = perimeters::difference(&area, &self.trimming);
        // Samples: up to four corners of each island of the support, pulled in a hair.
        let source = if offset > 0 {
            self.support.clone()
        } else {
            perimeters::intersection(&self.support, &islands)
        };
        let mut samples: Vec<IntPoint<i32>> = Vec::new();
        for shape in &source {
            if let Some(ring) = perimeters::offset(&vec![shape.clone()], -1)
                .first()
                .and_then(|s| s.first())
            {
                let n = ring.len();
                if n == 0 {
                    continue;
                }
                let stride = (n / n.min(4)).max(1);
                samples.extend(ring.iter().step_by(stride).copied());
            }
        }
        let kept: Shapes = islands
            .into_iter()
            .filter(|island| {
                samples
                    .iter()
                    .any(|p| crate::support::point_in(&vec![island.clone()], p.x, p.y))
            })
            .collect();
        turn(&kept, self.angle_deg, self.center)
    }
}

#[allow(clippy::cast_possible_truncation, reason = "a point inside the bed")]
fn pt(x: f64, y: f64) -> IntPoint<i32> {
    IntPoint::new(x.round() as i32, y.round() as i32)
}

/// `area` turned by `deg` degrees about `center` (mm).
pub(crate) fn turn(area: &Shapes, deg: f64, center: [f64; 2]) -> Shapes {
    if deg.rem_euclid(360.0).abs() < 1e-12 {
        return area.clone();
    }
    let (sn, cs) = deg.to_radians().m_sin_cos();
    let (ox, oy) = (center[0] * SCALE, center[1] * SCALE);
    area.iter()
        .map(|shape| {
            shape
                .iter()
                .map(|ring| {
                    ring.iter()
                        .map(|p| {
                            let (x, y) = (f64::from(p.x) - ox, f64::from(p.y) - oy);
                            pt(ox + x * cs - y * sn, oy + x * sn + y * cs)
                        })
                        .collect()
                })
                .collect()
        })
        .collect()
}

/// The pixels of an `nx` by `ny` grid (lower left corner `origin`, side `pixel`) that `shapes` cover any
/// part of: the exact covered area of each pixel, as an anti-aliased scanline rasterizer sums it, set
/// when it reaches one 256th of the pixel.
fn rasterize(shapes: &Shapes, nx: usize, ny: usize, origin: (f64, f64), pixel: f64) -> Vec<u8> {
    // Per pixel: the signed area covered within it, and per row the signed height that covers every pixel
    // to the right of where an edge crosses.
    let mut area = vec![0.0_f64; nx * ny];
    let mut cover = vec![0.0_f64; (nx + 1) * ny];
    #[allow(clippy::cast_precision_loss, reason = "grid sizes are small")]
    let (fx, fy) = (nx as f64, ny as f64);
    for ring in shapes.iter().flat_map(|s| s.iter()) {
        let n = ring.len();
        for k in 0..n {
            let (Some(a), Some(b)) = (ring.get(k), ring.get((k + 1) % n)) else {
                continue;
            };
            let (x0, y0) = (
                (f64::from(a.x) - origin.0) / pixel,
                (f64::from(a.y) - origin.1) / pixel,
            );
            let (x1, y1) = (
                (f64::from(b.x) - origin.0) / pixel,
                (f64::from(b.y) - origin.1) / pixel,
            );
            if (y1 - y0).abs() < 1e-12 {
                continue;
            }
            let (lo, hi) = (y0.min(y1).max(0.0), y0.max(y1).min(fy));
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "grid indexes are small"
            )]
            let (r0, r1) = (lo.floor() as usize, (hi.ceil() as usize).min(ny));
            for r in r0..r1 {
                #[allow(clippy::cast_precision_loss, reason = "grid indexes are small")]
                let (ya, yb) = ((r as f64).max(lo), ((r + 1) as f64).min(hi));
                if yb <= ya {
                    continue;
                }
                let xat = |y: f64| x0 + (x1 - x0) * (y - y0) / (y1 - y0);
                // The piece of the edge in this row, in its own direction.
                let (sa, sb) = if y1 > y0 { (ya, yb) } else { (yb, ya) };
                let (xa, xb) = (xat(sa), xat(sb));
                let dy = sb - sa;
                add_piece(
                    &mut area,
                    &mut cover,
                    nx,
                    r,
                    (xa.clamp(0.0, fx), xb.clamp(0.0, fx)),
                    dy,
                );
            }
        }
    }
    let mut out = vec![0_u8; nx * ny];
    for r in 0..ny {
        let mut run = 0.0;
        for c in 0..nx {
            let here = area.get(r * nx + c).copied().unwrap_or(0.0);
            let cov = (run + here).abs();
            if cov >= 1.0 / 256.0
                && let Some(v) = out.get_mut(r * nx + c)
            {
                *v = 1;
            }
            run += cover.get(r * (nx + 1) + c).copied().unwrap_or(0.0);
        }
    }
    out
}

/// Adds one edge piece inside row `r` running from x `xs.0` to `xs.1` over a signed height `dy`.
fn add_piece(area: &mut [f64], cover: &mut [f64], nx: usize, r: usize, xs: (f64, f64), dy: f64) {
    let (xa, xb) = xs;
    let (lo, hi) = (xa.min(xb), xa.max(xb));
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "grid indexes are small"
    )]
    let (c0, c1) = (
        lo.floor() as usize,
        (hi.floor() as usize).min(nx.saturating_sub(1)),
    );
    if c0 >= nx {
        return;
    }
    let span = hi - lo;
    for c in c0..=c1.max(c0) {
        #[allow(clippy::cast_precision_loss, reason = "grid indexes are small")]
        let (l, h) = ((c as f64).max(lo), ((c + 1) as f64).min(hi));
        // The share of the height in this column (all of it for a vertical piece).
        let part = if span < 1e-12 {
            dy
        } else {
            dy * (h - l).max(0.0) / span
        };
        if span >= 1e-12 && h < l {
            continue;
        }
        #[allow(clippy::cast_precision_loss, reason = "grid indexes are small")]
        let mid = f64::midpoint(l, h) - c as f64;
        // Within the column the area right of the piece is covered; every column further right is covered fully.
        if let Some(v) = area.get_mut(r * nx + c) {
            *v += part * (1.0 - mid);
        }
        if let Some(v) = cover.get_mut(r * (nx + 1) + c) {
            *v += part;
        }
    }
}

/// The pixels whose whole 3 by 3 neighborhood is set: the part shrunk by a pixel, so the spreading stops
/// just short of it.
fn erode(mask: &[u8], nx: usize, ny: usize) -> Vec<u8> {
    let mut out = vec![0_u8; mask.len()];
    let on = |c: usize, r: usize| mask.get(r * nx + c).copied().unwrap_or(0) != 0;
    for r in 1..ny.saturating_sub(1) {
        for c in 1..nx.saturating_sub(1) {
            let all = (r - 1..=r + 1).all(|rr| (c - 1..=c + 1).all(|cc| on(cc, rr)));
            if all && let Some(v) = out.get_mut(r * nx + c) {
                *v = 1;
            }
        }
    }
    out
}

/// Spreads the set pixels of each `size` by `size` block (blocks start one pixel in) to their neighbors,
/// down and across then up and across, never into or out of a masked pixel.
fn seed_fill_blocks(grid: &mut [u8], mask: &[u8], stride: usize, blocks: (usize, usize), size: usize) {
    for br in 0..blocks.1 {
        for bc in 0..blocks.0 {
            let base = bc * size + 1 + (br * size + 1) * stride;
            let mut step = |r: usize, c: usize, from: isize| {
                let addr = base + r * stride + c;
                let Some(src) = addr.checked_add_signed(from) else {
                    return;
                };
                let set = grid.get(src).copied().unwrap_or(0) != 0;
                let free =
                    mask.get(addr).copied().unwrap_or(1) == 0 && mask.get(src).copied().unwrap_or(1) == 0;
                if set
                    && free
                    && let Some(v) = grid.get_mut(addr)
                {
                    *v = 1;
                }
            };
            let s = stride.cast_signed();
            for r in 0..size {
                if r > 0 {
                    for c in 0..size {
                        step(r, c, -s);
                    }
                }
                for c in 1..size {
                    step(r, c, -1);
                }
                for c in (0..size.saturating_sub(1)).rev() {
                    step(r, c, 1);
                }
            }
            for r in (0..size.saturating_sub(1)).rev() {
                for c in 0..size {
                    step(r, c, s);
                }
                for c in 1..size {
                    step(r, c, -1);
                }
                for c in (0..size.saturating_sub(1)).rev() {
                    step(r, c, 1);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let p = |x: f64, y: f64| IntPoint::new(crate::geom::mm(x), crate::geom::mm(y));
        vec![vec![vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]]]
    }

    #[test]
    fn an_island_fills_the_cells_it_touches() {
        // 2.877 mm cells around 128, 128: a square from 116 to 140 by 118 to 138 fills cells from
        // 113.6 to 142.4 in x and 116.5 to 139.5 in y.
        let g = GridPattern::new(
            &rect(116.0, 118.0, 140.0, 138.0),
            &Vec::new(),
            2.877,
            0.377,
            0.0,
            [128.0, 128.0],
        )
        .unwrap();
        let out = g.extract(0, true);
        let b = perimeters::bounds(&out).unwrap();
        let mm = |v: i32| f64::from(v) / SCALE;
        assert!((mm(b[0]) - (128.0 - 5.0 * 2.877)).abs() < 0.01, "{}", mm(b[0]));
        assert!((mm(b[2]) - (128.0 + 5.0 * 2.877)).abs() < 0.01, "{}", mm(b[2]));
        assert!((mm(b[1]) - (128.0 - 4.0 * 2.877)).abs() < 0.01, "{}", mm(b[1]));
        assert!((mm(b[3]) - (128.0 + 4.0 * 2.877)).abs() < 0.01, "{}", mm(b[3]));
    }

    #[test]
    fn an_edge_just_inside_a_cell_edge_stays_in_that_cell() {
        // 11.5 mm from the center is 8 micrometers inside the fourth cell edge (4 x 2.877 = 11.508).
        let g = GridPattern::new(
            &rect(116.5, 116.5, 139.5, 139.5),
            &Vec::new(),
            2.877,
            0.377,
            0.0,
            [128.0, 128.0],
        )
        .unwrap();
        let b = perimeters::bounds(&g.extract(0, true)).unwrap();
        assert!(
            (f64::from(b[2]) / SCALE - (128.0 + 4.0 * 2.877)).abs() < 0.01,
            "{}",
            f64::from(b[2]) / SCALE
        );
        assert!(
            (f64::from(b[0]) / SCALE - (128.0 - 4.0 * 2.877)).abs() < 0.01,
            "{}",
            f64::from(b[0]) / SCALE
        );
    }

    #[test]
    fn the_cells_stop_at_the_part() {
        // A wall through the middle of a cell: the island on its left fills only the left side.
        let wall = rect(129.0, 100.0, 130.0, 160.0);
        let g = GridPattern::new(
            &rect(126.0, 126.0, 128.5, 130.0),
            &wall,
            2.877,
            0.377,
            0.0,
            [128.0, 128.0],
        )
        .unwrap();
        let out = g.extract(0, true);
        let b = perimeters::bounds(&out).unwrap();
        assert!(
            f64::from(b[2]) / SCALE <= 129.0 + 1e-6,
            "{}",
            f64::from(b[2]) / SCALE
        );
    }
}
