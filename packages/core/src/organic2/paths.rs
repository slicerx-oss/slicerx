// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Toolpaths of an organic support layer (spec 7.7): hollow branches of one or two walls, or a sheath
//! with infill, a flange on the first layer, and dense lines for contacts and interfaces.

use super::assemble::Layer;
use super::ops;
use crate::geom::Point;
use crate::perimeters::Shapes;

/// What the toolpaths read.
#[derive(Debug, Clone)]
pub(crate) struct PathsIn {
    pub(crate) width: f64,
    pub(crate) spacing: f64,
    pub(crate) first_spacing: f64,
    pub(crate) first_density: f64,
    pub(crate) support_density: f64,
    pub(crate) top_interface_density: f64,
    pub(crate) bottom_interface_density: f64,
    /// Base lines direction, degrees.
    pub(crate) angle: f64,
    /// `tree_support_wall_count`.
    pub(crate) wall_count: u32,
    /// The base pattern is none or default: branches print as walls only.
    pub(crate) hollow: bool,
    pub(crate) center: [f64; 2],
}

/// Above this print Z (mm) every branch island gets a second wall.
const DOUBLE_WALL_Z: f64 = 100.0;

impl PathsIn {
    /// The island area (mm^2) past which a hollow branch gets a second, inner wall.
    pub(crate) fn double_wall_area(&self) -> f64 {
        match self.wall_count {
            0 => 0.25 * std::f64::consts::PI * 25.0,
            1 => f64::INFINITY,
            _ => 0.1,
        }
    }
}

/// The closed rings of `s` as polylines that end where they start, shortened at the seam by `clip` mm.
fn loops(s: &Shapes, clip: f64) -> Vec<Vec<Point>> {
    let mut out = Vec::new();
    for ring in s.iter().flatten() {
        let mut pl: Vec<Point> = ring.iter().map(|p| Point::new(p.x, p.y)).collect();
        if let Some(&f) = pl.first() {
            pl.push(f);
        }
        let total: f64 = pl
            .windows(2)
            .map(|w| match w {
                [a, b] => a.dist_mm(*b),
                _ => 0.0,
            })
            .sum();
        if total <= 2.0 * clip {
            if pl.len() >= 3 {
                out.push(pl);
            }
            continue;
        }
        // Drop `clip` mm from the end so the loop does not print over its own start.
        let mut left = clip;
        while left > 0.0 && pl.len() >= 2 {
            let (Some(&b), Some(&a)) = (pl.last(), pl.get(pl.len() - 2)) else {
                break;
            };
            let d = a.dist_mm(b);
            if d <= left {
                pl.pop();
                left -= d;
            } else {
                let t = (d - left) / d;
                if let Some(last) = pl.last_mut() {
                    *last = Point::from_mm(
                        a.x_mm() + (b.x_mm() - a.x_mm()) * t,
                        a.y_mm() + (b.y_mm() - a.y_mm()) * t,
                    );
                }
                left = 0.0;
            }
        }
        if pl.len() >= 2 {
            out.push(pl);
        }
    }
    out
}

fn lines(area: &Shapes, w: f64, spacing: f64, density: f64, angle: f64, center: [f64; 2]) -> Vec<Vec<Point>> {
    if area.is_empty() || density <= 0.0 {
        return Vec::new();
    }
    let pitch = (spacing / density.min(1.0)).max(spacing);
    crate::patterns::support_lines(area, w, pitch, angle, false, 0.0, center)
}

/// Walls of the hollow branches of `base` (one, or two for big islands and above 100 mm).
pub(crate) fn branch_walls(base: &Shapes, inp: &PathsIn, print_z: f64) -> Vec<Vec<Point>> {
    let clip = 0.15 * inp.spacing;
    let mut out = Vec::new();
    for island in ops::islands(base) {
        let outer = ops::grow(&island, -inp.width / 2.0);
        if outer.is_empty() {
            // Narrower than a line: one pass along the middle.
            out.extend(loops(&ops::grow(&island, -inp.width / 4.0), clip));
            continue;
        }
        let second = print_z > DOUBLE_WALL_Z || ops::area(&island) > inp.double_wall_area();
        if second {
            let inner = ops::grow(&outer, -inp.spacing);
            out.extend(loops(&inner, clip));
        }
        out.extend(loops(&outer, clip));
    }
    out
}

/// Walls of the branches passing through a raft layer.
pub(crate) fn raft_walls(trees: &Shapes, width: f64, spacing: f64, wall_count: u32) -> Vec<Vec<Point>> {
    let inp = PathsIn {
        width,
        spacing,
        first_spacing: spacing,
        first_density: 1.0,
        support_density: 0.0,
        top_interface_density: 0.0,
        bottom_interface_density: 0.0,
        angle: 0.0,
        wall_count,
        hollow: true,
        center: [0.0, 0.0],
    };
    branch_walls(trees, &inp, 0.0)
}

/// The support and interface paths of one layer. `first` is the layer on the bed.
pub(crate) fn layer_paths(
    l: &Layer,
    first: bool,
    print_z: f64,
    inp: &PathsIn,
) -> (Vec<Vec<Point>>, Vec<Vec<Point>>) {
    let mut support = Vec::new();
    let w = inp.width;
    if first {
        // The flange: a sheath and dense lines across the base angle.
        let sheath = ops::grow(&l.base, -w / 2.0);
        support.extend(loops(&sheath, 0.15 * inp.first_spacing));
        let inside = ops::grow(&l.base, -w);
        support.extend(lines(
            &inside,
            w,
            inp.first_spacing,
            inp.first_density,
            inp.angle + 90.0,
            inp.center,
        ));
    } else if inp.hollow {
        support.extend(branch_walls(&l.base, inp, print_z));
    } else {
        let sheath = ops::grow(&l.base, -w / 2.0);
        support.extend(loops(&sheath, 0.15 * inp.spacing));
        let inside = ops::grow(&l.base, -(w / 2.0 + 0.4 * inp.spacing));
        support.extend(lines(
            &inside,
            w,
            inp.spacing,
            inp.support_density,
            inp.angle,
            inp.center,
        ));
    }
    let mut interface = Vec::new();
    let across = inp.angle + 90.0;
    let dense = ops::union_many(&[&l.top_contact, &l.interface, &l.base_interface]);
    interface.extend(lines(
        &dense,
        w,
        inp.spacing,
        inp.top_interface_density,
        across,
        inp.center,
    ));
    interface.extend(lines(
        &l.bottom_contact,
        w,
        inp.spacing,
        inp.bottom_interface_density,
        across,
        inp.center,
    ));
    (support, interface)
}

/// Length of polylines in millimeters.
#[cfg(test)]
pub(crate) fn length(paths: &[Vec<Point>]) -> f64 {
    use crate::fm::Fm as _;
    use crate::geom::SCALE;
    paths
        .iter()
        .flat_map(|p| p.windows(2))
        .map(|w| match w {
            [a, b] => f64::from(b.x - a.x).m_hypot(f64::from(b.y - a.y)) / SCALE,
            _ => 0.0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::SCALE;

    fn inp(wall_count: u32) -> PathsIn {
        PathsIn {
            width: 0.4,
            spacing: 0.4,
            first_spacing: 0.4,
            first_density: 0.9,
            support_density: 0.15,
            top_interface_density: 0.5,
            bottom_interface_density: 0.5,
            angle: 0.0,
            wall_count,
            hollow: true,
            center: [100.0, 100.0],
        }
    }

    fn disc(r: f64) -> Shapes {
        ops::round_circle(ops::to_p(100.0 * SCALE, 100.0 * SCALE), r)
    }

    #[test]
    fn small_islands_get_one_wall_big_ones_two() {
        let i = inp(0);
        assert_eq!(branch_walls(&disc(2.0), &i, 10.0).len(), 1);
        assert_eq!(branch_walls(&disc(3.0), &i, 10.0).len(), 2);
        // Above 100 mm every island has two.
        assert_eq!(branch_walls(&disc(2.0), &i, 120.0).len(), 2);
        // One wall setting: never a second wall below 100 mm.
        assert_eq!(branch_walls(&disc(3.0), &inp(1), 10.0).len(), 1);
        // Two or more: a second wall on all but specks.
        assert_eq!(branch_walls(&disc(2.0), &inp(2), 10.0).len(), 2);
    }

    #[test]
    fn loops_are_clipped_at_the_seam() {
        let l = loops(&disc(2.0), 0.06);
        let total = length(&l);
        assert!(
            (total - (std::f64::consts::TAU * 2.0 - 0.06)).abs() < 0.05,
            "{total}"
        );
    }
}
