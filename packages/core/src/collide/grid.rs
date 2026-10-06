// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Height grids on a 1 mm lattice anchored at the bed's origin: the tallest point of a finished object over each
//! cell, and the same grid grown by a piece of the head, so one lookup answers "how tall is the object anywhere
//! under this piece of the head".

use crate::plate::PlateObject;

/// Cell size, mm.
pub(crate) const CELL: f64 = 1.0;

/// Heights over cells `x0..x0 + w`, `y0..y0 + h` of the lattice (cell `i` spans `i` to `i + 1` mm); 0 is bare bed.
#[derive(Debug, Clone, Default)]
pub(crate) struct Grid {
    pub x0: i32,
    pub y0: i32,
    pub w: usize,
    pub h: usize,
    pub z: Vec<f32>,
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    reason = "cell indices of a bed a few hundred mm across"
)]
fn cell(v: f64) -> i32 {
    (v / CELL).floor() as i32
}

impl Grid {
    fn new(x0: i32, y0: i32, w: usize, h: usize) -> Self {
        Self {
            x0,
            y0,
            w,
            h,
            z: vec![0.0; w * h],
        }
    }

    /// The tallest point of `obj` over each cell. A triangle that spans a few cells raises them to its top; a larger
    /// one is clipped to each cell's column, so a long sloped or vertical face raises a cell only as high as it is there.
    pub(crate) fn of_object(obj: &PlateObject) -> Self {
        let mut tris: Vec<[[f64; 3]; 3]> = Vec::new();
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for part in &obj.mesh.parts {
            let pts: Vec<[f64; 3]> = part.positions.iter().map(|&p| obj.apply(p)).collect();
            for t in &part.triangles {
                let (Some(a), Some(b), Some(c)) = (
                    pts.get(t[0] as usize),
                    pts.get(t[1] as usize),
                    pts.get(t[2] as usize),
                ) else {
                    continue;
                };
                for p in [a, b, c] {
                    lo = [lo[0].min(p[0]), lo[1].min(p[1])];
                    hi = [hi[0].max(p[0]), hi[1].max(p[1])];
                }
                tris.push([*a, *b, *c]);
            }
        }
        if tris.is_empty() {
            return Self::default();
        }
        let (x0, y0) = (cell(lo[0]), cell(lo[1]));
        let w = usize::try_from(cell(hi[0]) - x0 + 1).unwrap_or(0);
        let h = usize::try_from(cell(hi[1]) - y0 + 1).unwrap_or(0);
        let mut g = Self::new(x0, y0, w, h);
        for t in &tris {
            g.raise(t);
        }
        g
    }

    fn raise(&mut self, t: &[[f64; 3]; 3]) {
        let xs = t.map(|p| p[0]);
        let ys = t.map(|p| p[1]);
        let top = t.iter().map(|p| p[2]).fold(f64::MIN, f64::max);
        let (cx0, cx1) = (
            cell(xs.iter().copied().fold(f64::MAX, f64::min)),
            cell(xs.iter().copied().fold(f64::MIN, f64::max)),
        );
        let (cy0, cy1) = (
            cell(ys.iter().copied().fold(f64::MAX, f64::min)),
            cell(ys.iter().copied().fold(f64::MIN, f64::max)),
        );
        let small = cx1 - cx0 <= 1 && cy1 - cy0 <= 1;
        for cy in cy0..=cy1 {
            for cx in cx0..=cx1 {
                let z = if small {
                    Some(top)
                } else {
                    column_top(t, f64::from(cx) * CELL, f64::from(cy) * CELL)
                };
                if let Some(z) = z {
                    self.lift(cx, cy, z);
                }
            }
        }
    }

    #[allow(clippy::cast_possible_truncation, reason = "heights of a print fit in f32")]
    fn lift(&mut self, cx: i32, cy: i32, z: f64) {
        if let Some(i) = self.index(cx, cy)
            && let Some(v) = self.z.get_mut(i)
        {
            *v = v.max(z as f32);
        }
    }

    fn index(&self, cx: i32, cy: i32) -> Option<usize> {
        let x = usize::try_from(cx - self.x0).ok()?;
        let y = usize::try_from(cy - self.y0).ok()?;
        (x < self.w && y < self.h).then_some(y * self.w + x)
    }

    /// Height of the cell under `x`, `y`; 0 off the grid.
    pub(crate) fn at(&self, x: f64, y: f64) -> f32 {
        self.index(cell(x), cell(y))
            .and_then(|i| self.z.get(i).copied())
            .unwrap_or(0.0)
    }

    /// The grid grown by a box `[x0, x1] x [y0, y1]` around a point: at each cell, the tallest point of this grid under
    /// that box placed anywhere in the cell. One sliding maximum per axis.
    pub(crate) fn grown(&self, bx: [f64; 2], by: [f64; 2]) -> Self {
        if self.z.is_empty() {
            return Self::default();
        }
        // Under a box at a point in cell i lie cells i + a to i + b.
        let (ax, bxx) = (cell(bx[0]), (bx[1] / CELL).ceil());
        let (ay, byy) = (cell(by[0]), (by[1] / CELL).ceil());
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a head is a few hundred mm across at most"
        )]
        let (bxx, byy) = (bxx as i32, byy as i32);
        let (kx, ky) = (
            usize::try_from(bxx - ax + 1).unwrap_or(1),
            usize::try_from(byy - ay + 1).unwrap_or(1),
        );
        let w = self.w + kx - 1;
        let h = self.h + ky - 1;
        let mut rows = vec![0.0f32; w * self.h];
        for y in 0..self.h {
            let src = self.z.get(y * self.w..(y + 1) * self.w).unwrap_or(&[]);
            let dst = rows.get_mut(y * w..(y + 1) * w).unwrap_or(&mut []);
            sliding_max(src, kx, dst);
        }
        let mut out = Self::new(self.x0 - bxx, self.y0 - byy, w, h);
        let mut col = vec![0.0f32; self.h];
        let mut grown = vec![0.0f32; h];
        for x in 0..w {
            for (y, c) in col.iter_mut().enumerate() {
                *c = rows.get(y * w + x).copied().unwrap_or(0.0);
            }
            sliding_max(&col, ky, &mut grown);
            for (y, v) in grown.iter().enumerate() {
                if let Some(d) = out.z.get_mut(y * w + x) {
                    *d = *v;
                }
            }
        }
        out
    }

    /// Per row of cells, the tallest point across it, grown by `reach` mm either way in y: what a gantry beam that
    /// spans the bed meets at each y.
    pub(crate) fn beam(&self, reach: f64) -> Profile {
        let mut rows: Vec<f32> = (0..self.h)
            .map(|y| {
                self.z
                    .get(y * self.w..(y + 1) * self.w)
                    .unwrap_or(&[])
                    .iter()
                    .copied()
                    .fold(0.0, f32::max)
            })
            .collect();
        #[allow(clippy::cast_possible_truncation, reason = "a beam reach of a few tens of mm")]
        let k = (reach / CELL).ceil().max(0.0) as i32;
        let n = rows.len() + usize::try_from(2 * k).unwrap_or(0);
        let mut out = vec![0.0f32; n];
        if !rows.is_empty() {
            sliding_max(&rows, usize::try_from(2 * k + 1).unwrap_or(1), &mut out);
        }
        rows.clear();
        Profile {
            y0: self.y0 - k,
            z: out,
        }
    }

    /// The cell under the box `[x0, x1] x [y0, y1]` (bed mm) nearest to `p` among those taller than `over`, and how far
    /// the cells taller than `over` reach into the box from its nearest side (the shift that clears them).
    pub(crate) fn contact(&self, rect: [f64; 4], over: f32, p: [f64; 2]) -> Option<([f64; 2], f32)> {
        let (cx0, cx1, cy0, cy1) = (cell(rect[0]), cell(rect[1]), cell(rect[2]), cell(rect[3]));
        let mut best: Option<([f64; 2], f64)> = None;
        let mut lo = [f64::MAX; 2];
        let mut hi = [f64::MIN; 2];
        for cy in cy0..=cy1 {
            for cx in cx0..=cx1 {
                let Some(z) = self.index(cx, cy).and_then(|i| self.z.get(i)) else {
                    continue;
                };
                if *z <= over {
                    continue;
                }
                let c = [(f64::from(cx) + 0.5) * CELL, (f64::from(cy) + 0.5) * CELL];
                let d = (c[0] - p[0]) * (c[0] - p[0]) + (c[1] - p[1]) * (c[1] - p[1]);
                if best.is_none_or(|(_, b)| d < b) {
                    best = Some((c, d));
                }
                lo = [lo[0].min(f64::from(cx) * CELL), lo[1].min(f64::from(cy) * CELL)];
                hi = [
                    hi[0].max(f64::from(cx + 1) * CELL),
                    hi[1].max(f64::from(cy + 1) * CELL),
                ];
            }
        }
        let (c, _) = best?;
        let push = (hi[0] - rect[0])
            .min(rect[1] - lo[0])
            .min(hi[1] - rect[2])
            .min(rect[3] - lo[1])
            .max(0.0);
        #[allow(clippy::cast_possible_truncation, reason = "mm")]
        Some((c, push as f32))
    }
}

/// A grid reduced to one value per row of cells (cells `y0..`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Profile {
    pub y0: i32,
    pub z: Vec<f32>,
}

impl Profile {
    pub(crate) fn at(&self, y: f64) -> f32 {
        usize::try_from(cell(y) - self.y0)
            .ok()
            .and_then(|i| self.z.get(i).copied())
            .unwrap_or(0.0)
    }
}

/// `out[i]` is the largest of `src[i + 1 - k ..= i]` (missing values count as 0), for `out.len() == src.len() + k - 1`.
fn sliding_max(src: &[f32], k: usize, out: &mut [f32]) {
    let mut q: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    for (i, slot) in out.iter_mut().enumerate() {
        if let Some(&v) = src.get(i) {
            while q.back().is_some_and(|&b| src.get(b).copied().unwrap_or(0.0) <= v) {
                q.pop_back();
            }
            q.push_back(i);
        }
        while q.front().is_some_and(|&f| f + k <= i) {
            q.pop_front();
        }
        *slot = q.front().and_then(|&f| src.get(f).copied()).unwrap_or(0.0);
    }
}

/// The highest point of triangle `t` over the cell column with corner `x`, `y`, or None when it misses the column.
fn column_top(t: &[[f64; 3]; 3], x: f64, y: f64) -> Option<f64> {
    let mut poly: Vec<[f64; 3]> = t.to_vec();
    for (axis, bound, keep_above) in [
        (0, x, true),
        (0, x + CELL, false),
        (1, y, true),
        (1, y + CELL, false),
    ] {
        poly = clip(&poly, axis, bound, keep_above);
        if poly.is_empty() {
            return None;
        }
    }
    poly.iter().map(|p| p[2]).reduce(f64::max)
}

/// Sutherland and Hodgman against one axis-aligned plane.
fn clip(poly: &[[f64; 3]], axis: usize, bound: f64, keep_above: bool) -> Vec<[f64; 3]> {
    let inside = |p: &[f64; 3]| {
        let v = p.get(axis).copied().unwrap_or(0.0);
        if keep_above { v >= bound } else { v <= bound }
    };
    let mut out = Vec::with_capacity(poly.len() + 2);
    for (i, a) in poly.iter().enumerate() {
        let Some(b) = poly.get((i + 1) % poly.len()) else {
            continue;
        };
        let (ia, ib) = (inside(a), inside(b));
        if ia {
            out.push(*a);
        }
        if ia != ib {
            let (va, vb) = (
                a.get(axis).copied().unwrap_or(0.0),
                b.get(axis).copied().unwrap_or(0.0),
            );
            let s = if (vb - va).abs() < 1e-12 {
                0.0
            } else {
                (bound - va) / (vb - va)
            };
            out.push([
                a[0] + s * (b[0] - a[0]),
                a[1] + s * (b[1] - a[1]),
                a[2] + s * (b[2] - a[2]),
            ]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(x0: i32, y0: i32, w: usize, h: usize, z: f32) -> Grid {
        Grid {
            x0,
            y0,
            w,
            h,
            z: vec![z; w * h],
        }
    }

    #[test]
    fn a_grown_grid_answers_for_the_whole_box_around_a_point() {
        // a 10 mm square block 20 mm tall at x 50..60, y 50..60
        let g = flat(50, 50, 10, 10, 20.0);
        let grown = g.grown([-5.0, 5.0], [-2.0, 2.0]);
        // a box reaching 5 mm right of the nozzle meets the block from x 45 on, not from 43
        assert!(grown.at(45.5, 55.0) > 19.0);
        assert!(grown.at(43.5, 55.0) < 1.0);
        // and 2 mm in y
        assert!(grown.at(55.0, 48.5) > 19.0);
        assert!(grown.at(55.0, 46.5) < 1.0);
        assert!(grown.at(64.5, 55.0) > 19.0 && grown.at(65.5, 55.0) < 1.0);
    }

    #[test]
    fn a_beam_meets_what_stands_within_its_reach() {
        let g = flat(50, 50, 10, 10, 30.0);
        let b = g.beam(20.0);
        assert!(b.at(30.5) > 29.0 && b.at(79.5) > 29.0);
        assert!(b.at(28.5) < 1.0 && b.at(81.5) < 1.0);
    }

    #[test]
    fn a_long_sloped_face_raises_each_cell_only_as_high_as_it_is_there() {
        let mut g = flat(0, 0, 40, 4, 0.0);
        // a ramp from z 0 at x 0 to z 40 at x 40, 4 mm wide
        g.raise(&[[0.0, 0.0, 0.0], [40.0, 0.0, 40.0], [40.0, 4.0, 40.0]]);
        g.raise(&[[0.0, 0.0, 0.0], [40.0, 4.0, 40.0], [0.0, 4.0, 0.0]]);
        assert!((g.at(10.5, 2.0) - 11.0).abs() < 0.01);
        assert!((g.at(39.5, 2.0) - 40.0).abs() < 0.01);
    }

    #[test]
    fn contact_finds_the_nearest_tall_cell_and_the_shift_that_clears_it() {
        let g = flat(50, 50, 10, 10, 20.0);
        // a box from x 40 to 55 around a nozzle at x 45: the block reaches 5 mm into it from the right
        let (c, push) = g.contact([40.0, 55.0, 50.0, 60.0], 5.0, [45.0, 55.0]).unwrap();
        assert!((c[0] - 50.5).abs() < 1e-9);
        assert!((push - 5.0).abs() < 1e-6);
        assert!(g.contact([10.0, 20.0, 10.0, 20.0], 5.0, [15.0, 15.0]).is_none());
    }
}
