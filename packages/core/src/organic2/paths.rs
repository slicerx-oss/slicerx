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
    /// Neighboring fill lines are joined along the edge when the way round is at most this long (mm).
    pub(crate) join: f64,
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

struct Fill {
    w: f64,
    spacing: f64,
    density: f64,
    angle: f64,
    center: [f64; 2],
    join: f64,
}

fn lines(area: &Shapes, f: &Fill) -> Vec<Vec<Point>> {
    if area.is_empty() || f.density <= 0.0 {
        return Vec::new();
    }
    let pitch = (f.spacing / f.density.min(1.0)).max(f.spacing);
    crate::patterns::support_lines(area, f.w, pitch, f.angle, false, f.join.max(0.0), f.center)
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
        let reach = ANCHOR_SPACINGS * inp.spacing;
        let inner = ops::grow(&outer, -inp.spacing);
        if second {
            let anchor_ring = ops::grow(&inner, -inp.spacing);
            out.extend(
                loops(&inner, clip)
                    .into_iter()
                    .map(|l| anchored(l, &anchor_ring, reach)),
            );
        }
        out.extend(
            loops(&outer, clip)
                .into_iter()
                .map(|l| anchored(l, &inner, reach)),
        );
    }
    out
}

/// How far (in line spacings) a wall loop's anchor runs along the next loop inward.
const ANCHOR_SPACINGS: f64 = 6.0;

/// `pl` started from an anchor: the last `len` mm of the ring of `inner` that ends nearest the loop's
/// start, so the wall begins on a line laid inside it. Unchanged when nothing lies inward.
fn anchored(pl: Vec<Point>, inner: &Shapes, len: f64) -> Vec<Point> {
    let Some(&start) = pl.first() else {
        return pl;
    };
    // The nearest point of any inner ring: ring, segment index, and the point.
    let mut best: Option<(f64, &Vec<ops::P>, usize, Point)> = None;
    for ring in inner.iter().flatten() {
        let n = ring.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let (Some(a), Some(b)) = (ring.get(i), ring.get((i + 1) % n)) else {
                continue;
            };
            let (a, b) = (Point::new(a.x, a.y), Point::new(b.x, b.y));
            let q = nearest_on(a, b, start);
            let d = q.dist_mm(start);
            if best.as_ref().is_none_or(|(bd, ..)| d < *bd) {
                best = Some((d, ring, i, q));
            }
        }
    }
    let Some((_, ring, i, q)) = best else {
        return pl;
    };
    let n = ring.len();
    let at = |k: usize| ring.get(k % n).map(|p| Point::new(p.x, p.y));
    let ring_len: f64 = (0..n).filter_map(|k| Some(at(k)?.dist_mm(at(k + 1)?))).sum();
    // Walk back from q along the ring, then lay the anchor forward to q.
    let mut left = len.min(0.9 * ring_len);
    let mut back = vec![q];
    let mut cur = q;
    let mut k = i;
    while left > 1e-9 {
        let Some(v) = at(k) else { break };
        let d = cur.dist_mm(v);
        if d >= left {
            let t = left / d;
            back.push(Point::from_mm(
                cur.x_mm() + (v.x_mm() - cur.x_mm()) * t,
                cur.y_mm() + (v.y_mm() - cur.y_mm()) * t,
            ));
            break;
        }
        back.push(v);
        left -= d;
        cur = v;
        k = (k + n - 1) % n;
    }
    back.reverse();
    back.extend(pl);
    back
}

/// The point of segment `a`-`b` nearest `p`.
fn nearest_on(a: Point, b: Point, p: Point) -> Point {
    let (dx, dy) = (b.x_mm() - a.x_mm(), b.y_mm() - a.y_mm());
    let l2 = dx * dx + dy * dy;
    if l2 <= 0.0 {
        return a;
    }
    let t = (((p.x_mm() - a.x_mm()) * dx + (p.y_mm() - a.y_mm()) * dy) / l2).clamp(0.0, 1.0);
    Point::from_mm(a.x_mm() + dx * t, a.y_mm() + dy * t)
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
        join: 0.0,
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
            &Fill {
                w,
                spacing: inp.first_spacing,
                density: inp.first_density,
                angle: inp.angle + 90.0,
                center: inp.center,
                join: inp.join,
            },
        ));
    } else if inp.hollow {
        support.extend(branch_walls(&l.base, inp, print_z));
    } else {
        let sheath = ops::grow(&l.base, -w / 2.0);
        support.extend(loops(&sheath, 0.15 * inp.spacing));
        let inside = ops::grow(&l.base, -(w / 2.0 + 0.4 * inp.spacing));
        support.extend(lines(
            &inside,
            &Fill {
                w,
                spacing: inp.spacing,
                density: inp.support_density,
                angle: inp.angle,
                center: inp.center,
                join: inp.join,
            },
        ));
    }
    let mut interface = Vec::new();
    let across = inp.angle + 90.0;
    let dense = ops::union_many(&[&l.top_contact, &l.interface, &l.base_interface]);
    interface.extend(lines(
        &dense,
        &Fill {
            w,
            spacing: inp.spacing,
            density: inp.top_interface_density,
            angle: across,
            center: inp.center,
            join: inp.join,
        },
    ));
    interface.extend(lines(
        &l.bottom_contact,
        &Fill {
            w,
            spacing: inp.spacing,
            density: inp.bottom_interface_density,
            angle: across,
            center: inp.center,
            join: inp.join,
        },
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
    use crate::fm::Fm as _;
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
            join: 0.0,
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

    #[test]
    fn a_wall_starts_on_an_anchor_inside_it() {
        let i = inp(1);
        let walls = branch_walls(&disc(2.0), &i, 10.0);
        let [wall] = walls.as_slice() else {
            panic!("one wall expected, got {}", walls.len());
        };
        let r = |p: &Point| (p.x_mm() - 100.0).m_hypot(p.y_mm() - 100.0);
        let first = wall.first().map_or(0.0, r);
        // The anchor lies on the next loop inward: 2.0 - 0.2 - 0.4 from the center.
        assert!((first - 1.4).abs() < 0.05, "{first}");
        // Loop (radius 1.8, less the seam clip) plus about six spacings of anchor and the step out.
        let total = length(&walls);
        let lap = std::f64::consts::TAU * 1.8 - 0.06;
        assert!(total > lap + 2.4 && total < lap + 3.0, "{total} vs {lap}");
    }
}
