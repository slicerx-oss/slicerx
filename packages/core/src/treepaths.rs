// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Toolpaths of slim, strong and hybrid tree supports, as Orca's `TreeSupport::generate_toolpaths` and
//! `tree_supports_generate_paths` (Support/TreeSupport.cpp, Support/SupportCommon.cpp) draw them: branch walls
//! that start with a short anchor into the wall inside, a second wall on wide or flagged branches, walls and
//! infill on the normal-support part of hybrid trees, a perimeter and a fill on the first roof layer, the roof
//! and floor with the interface filler, and a dense pad on the bed.

#![allow(
    clippy::indexing_slicing,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "plate coordinates"
)]

use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::perimeters::{self, Shapes};
use crate::treeclassic::TreeLayer;
use i_overlay::i_float::int::point::IntPoint;

type Path = Vec<Point>;

fn u(mm: f64) -> i32 {
    (mm * SCALE).round() as i32
}

fn closed(ring: &[IntPoint<i32>]) -> Path {
    let mut p: Path = ring.iter().map(|q| Point::new(q.x, q.y)).collect();
    if let Some(f) = p.first().copied() {
        p.push(f);
    }
    p
}

fn len(a: Point, b: Point) -> f64 {
    f64::from(b.x - a.x).m_hypot(f64::from(b.y - a.y))
}

/// Orca's `Polyline::clip_end`.
fn clip_end(pl: &mut Path, mut d: f64) {
    while d > 0.0 {
        let Some(last) = pl.pop() else { return };
        let Some(&p) = pl.last() else { return };
        let l = len(last, p);
        if l > d {
            let t = d / l;
            pl.push(Point::new(
                (f64::from(last.x) + f64::from(p.x - last.x) * t).round() as i32,
                (f64::from(last.y) + f64::from(p.y - last.y) * t).round() as i32,
            ));
            return;
        }
        d -= l;
    }
}

/// Orca's `draw_perimeters`: every outline as a loop, holes reversed so all run one way, clipped at the end.
pub(crate) fn draw_perimeters(shape: &Shapes, clip: f64) -> Vec<Path> {
    let mut out = Vec::new();
    for sh in shape {
        for (k, ring) in sh.iter().enumerate() {
            let mut p = closed(ring);
            if k > 0 {
                p.reverse();
            }
            clip_end(&mut p, clip);
            if p.len() > 1 {
                out.push(p);
            }
        }
    }
    out
}

fn area(s: &Shapes) -> f64 {
    s.iter()
        .flat_map(|sh| sh.iter())
        .map(|r| crate::geom::area2_int(r) as f64 / 2.0)
        .sum()
}

/// Orca's `tree_supports_generate_paths`: each island pulled in half a line becomes a loop; islands wider
/// than `double_wall_mm2` get a second loop outside it. The inner loop starts with an anchor: it continues
/// along the wall one line further in for up to six line spacings from the point nearest its seam.
pub(crate) fn branch_walls(polys: &Shapes, w_mm: f64, spacing_mm: f64, double_wall_mm2: f64) -> Vec<Path> {
    branch_walls_around(polys, w_mm, spacing_mm, double_wall_mm2, None)
}

/// [`branch_walls`], also adding the center line of each island's innermost wall to `centers`.
pub(crate) fn branch_walls_around(
    polys: &Shapes,
    w_mm: f64,
    spacing_mm: f64,
    double_wall_mm2: f64,
    mut centers: Option<&mut Shapes>,
) -> Vec<Path> {
    let w = f64::from(u(w_mm));
    let spacing = spacing_mm * SCALE;
    let clip = spacing * 0.15;
    let anchor_len = spacing * 6.0;
    let mut out = Vec::new();
    let shrunk = perimeters::offset(&perimeters::union_all(&[polys]), -u(0.5 * w_mm));
    for ex in shrunk {
        let mut ex: Shapes = vec![ex];
        let mut regions = ex.clone();
        if double_wall_mm2 > 0.0 && area(&ex) > double_wall_mm2 * SCALE * SCALE {
            let level2 = perimeters::offset(&perimeters::offset(&ex, -(1.5 * w) as i32), (0.5 * w) as i32);
            if !level2.is_empty() {
                out.extend(draw_perimeters(&ex, clip));
                regions.clone_from(&level2);
                ex = level2;
            }
        }
        let _ = ex;
        if let Some(c) = centers.as_deref_mut() {
            c.extend(regions.iter().cloned());
        }
        for inner in regions {
            let one: Shapes = vec![inner.clone()];
            let candidates = perimeters::offset(&one, -(w as i32));
            for (k, ring) in inner.iter().enumerate() {
                let mut pl = closed(ring);
                // Orca orients every loop the same way and starts it with the anchor.
                if k == 0 {
                    pl.reverse();
                }
                clip_end(&mut pl, clip);
                if pl.len() < 2 {
                    continue;
                }
                let seam = pl[pl.len() - 1];
                if let Some(anchor) = anchor_from(&candidates, seam, 3.0 * w, anchor_len) {
                    pl.extend(anchor);
                }
                pl.reverse();
                out.push(pl);
            }
        }
    }
    out
}

/// How far [`wide_inside`] lets its outlines move before the disc test, 0.02 mm in internal units: under a
/// line width, and far under the base pitch the test measures (2.88 mm at default spacing).
const WIDE_TEST_TOL: i64 = 200;

/// What tree support infill fills inside hollow branches: `centers` (the center lines of their innermost walls)
/// pulled in by `inset_mm`, where that holds a disc of radius `r_mm`. Thin necks and slivers drop out, and a wide
/// part keeps its own outline.
pub(crate) fn wide_inside(centers: &Shapes, inset_mm: f64, r_mm: f64) -> Shapes {
    let reach = inset_mm + r_mm;
    // Most branches are narrower than that: their bounding box says so without an offset.
    let room = 2.0 * reach * SCALE;
    let wide: Shapes = centers
        .iter()
        .filter(|sh| {
            perimeters::bounds(std::slice::from_ref(*sh))
                .is_some_and(|b| f64::from(b[2] - b[0]) > room && f64::from(b[3] - b[1]) > room)
        })
        .cloned()
        .collect();
    if wide.is_empty() {
        return Vec::new();
    }
    // The shrink reads simplified outlines: the dense center lines of merged branches miss the quick offset when
    // shrunk by a few millimeters, and the full union cost about 3 ms per island. Only the disc test moves, by at
    // most WIDE_TEST_TOL, and inward; the fill never leaves the inset of the outlines as drawn.
    let coarse: Shapes = wide
        .iter()
        .filter_map(|sh| {
            let rings: Vec<_> = sh
                .iter()
                .map(|r| perimeters::simplify_ring(r, WIDE_TEST_TOL))
                .collect();
            rings
                .first()
                .is_some_and(|r| r.len() >= 3)
                .then(|| rings.into_iter().filter(|r| r.len() >= 3).collect())
        })
        .collect();
    let core = perimeters::offset(&coarse, -u(reach));
    if core.is_empty() {
        return Vec::new();
    }
    perimeters::intersection(
        &perimeters::offset(&core, u(r_mm)),
        &perimeters::offset(&wide, -u(inset_mm)),
    )
}

/// The anchor: from the point of `candidates` nearest `seam` (closer than `max_d`), along its ring for what is
/// left of `length` after reaching it.
fn anchor_from(candidates: &Shapes, seam: Point, max_d: f64, length: f64) -> Option<Path> {
    let mut best: Option<(f64, usize, usize, usize, f64)> = None;
    for (si, sh) in candidates.iter().enumerate() {
        for (ri, ring) in sh.iter().enumerate() {
            let n = ring.len();
            for i in 0..n {
                let (a, b) = (ring[i], ring[(i + 1) % n]);
                let (vx, vy) = (f64::from(b.x - a.x), f64::from(b.y - a.y));
                let l2 = vx * vx + vy * vy;
                let t = if l2 > 0.0 {
                    ((f64::from(seam.x - a.x) * vx + f64::from(seam.y - a.y) * vy) / l2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let (qx, qy) = (f64::from(a.x) + vx * t, f64::from(a.y) + vy * t);
                let d = (qx - f64::from(seam.x)).m_hypot(qy - f64::from(seam.y));
                if best.is_none_or(|bb| d < bb.0) {
                    best = Some((d, si, ri, i, t));
                }
            }
        }
    }
    let (d, si, ri, i, t) = best?;
    if d >= max_d {
        return None;
    }
    let ring = &candidates[si][ri];
    // Orca walks the candidate clockwise; outer rings come counterclockwise here, so walk backward.
    let ccw = crate::geom::area2_int(ring) > 0;
    let n = ring.len();
    let at = |k: usize| Point::new(ring[k % n].x, ring[k % n].y);
    let (a, b) = (at(i), at(i + 1));
    let start = Point::new(
        (f64::from(a.x) + f64::from(b.x - a.x) * t).round() as i32,
        (f64::from(a.y) + f64::from(b.y - a.y) * t).round() as i32,
    );
    let mut out = vec![start];
    let mut left = length - d;
    let mut cur = start;
    let mut k = if ccw { i } else { i + 1 };
    for _ in 0..n {
        if left <= 0.0 {
            break;
        }
        let next = at(k);
        let l = len(cur, next);
        if l >= left {
            let tt = left / l.max(1e-9);
            out.push(Point::new(
                (f64::from(cur.x) + f64::from(next.x - cur.x) * tt).round() as i32,
                (f64::from(cur.y) + f64::from(next.y - cur.y) * tt).round() as i32,
            ));
            break;
        }
        out.push(next);
        left -= l;
        cur = next;
        k = if ccw { (k + n - 1) % n } else { k + 1 };
    }
    Some(out)
}

/// Orca's `_make_loops` from `make_perimeter_and_infill`: up to `walls` loops, each further in by 1.4
/// spacings and grown back 0.4.
fn make_loops(area: &Shapes, walls: u32, spacing_mm: f64) -> Vec<Path> {
    let s = spacing_mm * SCALE;
    let mut out = Vec::new();
    let mut list: Vec<(Shapes, u32)> = area.iter().map(|sh| (vec![sh.clone()], 0)).collect();
    while let Some((ex, depth)) = list.pop() {
        out.extend(draw_perimeters(&ex, 0.0));
        if depth + 1 < walls {
            let next = perimeters::offset(&perimeters::offset(&ex, -(1.4 * s) as i32), (0.4 * s) as i32);
            for sh in next {
                list.push((vec![sh], depth + 1));
            }
        }
    }
    out
}

/// Orca's `make_perimeter_and_infill` with the infill drawn by `fill` inside `walls` spacings.
fn perimeter_and_infill(
    area: &Shapes,
    walls: u32,
    spacing_mm: f64,
    fill: &dyn Fn(&Shapes) -> Vec<Path>,
) -> Vec<Path> {
    let s = spacing_mm * SCALE;
    let inner = perimeters::offset(area, -(f64::from(walls) * s) as i32);
    let mut out = if walls > 0 {
        make_loops(&perimeters::offset(area, -(0.5 * s) as i32), walls, spacing_mm)
    } else {
        Vec::new()
    };
    out.extend(fill(&inner));
    out
}

/// What the tree toolpaths read.
#[derive(Debug, Clone)]
pub(crate) struct TreePathsIn {
    /// Support line width and the flow spacing at this layer, mm; the same for the first layer.
    pub(crate) width: f64,
    pub(crate) spacing: f64,
    pub(crate) first_width: f64,
    pub(crate) first_spacing: f64,
    pub(crate) interface_density: f64,
    pub(crate) bottom_density: f64,
    pub(crate) base_density: f64,
    pub(crate) first_density: f64,
    /// `support_angle`, degrees; the interface runs at a right angle to it unless the pattern says otherwise.
    pub(crate) angle: f64,
    pub(crate) interface_pattern: crate::config::InterfacePattern,
    /// The interface layer's number, for the interlaced pattern.
    pub(crate) interface_id: usize,
    pub(crate) wall_count: u32,
    /// Walls and infill on bases (`support_base_pattern` other than default and hollow); with the default
    /// pattern only the normal-support part of hybrid trees.
    pub(crate) with_infill: bool,
    pub(crate) default_pattern: bool,
    pub(crate) on_bed: bool,
    pub(crate) anchor_max: f64,
    pub(crate) center: [f64; 2],
    /// Tree support infill: hollow branches get the base filler inside their walls where that inside holds a
    /// disc of this radius, mm. None leaves them hollow.
    pub(crate) wide_fill: Option<f64>,
}

/// The support and interface paths of one tree layer.
pub(crate) fn layer_paths(t: &TreeLayer, p: &TreePathsIn) -> (Vec<Path>, Vec<Path>) {
    use crate::config::InterfacePattern as IP;
    let mut support: Vec<Path> = Vec::new();
    let mut interface: Vec<Path> = Vec::new();
    let rect = |area: &Shapes, spacing: f64, density: f64, angle: f64| -> Vec<Path> {
        crate::patterns::support_lines(
            area,
            spacing,
            spacing / density.max(1e-3),
            angle,
            false,
            p.anchor_max,
            p.center,
        )
    };
    // The interface filler: rectilinear when solid, else the support base filler, or the chosen pattern.
    let iface_fill = |area: &Shapes, density: f64| -> Vec<Path> {
        let mut angle = p.angle + 90.0;
        match p.interface_pattern {
            IP::Grid => angle = p.angle,
            IP::RectilinearInterlaced => angle = p.angle + if p.interface_id % 2 == 1 { 90.0 } else { 0.0 },
            _ => {}
        }
        match p.interface_pattern {
            IP::Concentric => crate::surface::fill(
                area,
                crate::surface::Curve::Concentric,
                p.spacing / density.max(1e-3),
                0.0,
            ),
            IP::Grid => {
                let mut v = rect(area, p.spacing, density / 2.0, angle);
                v.extend(rect(area, p.spacing, density / 2.0, angle + 90.0));
                v
            }
            _ if p.interface_density > 0.95 => rect(area, p.spacing, density, angle),
            _ => crate::supportfill::support_base(area, p.spacing, density, angle, p.center),
        }
    };
    // The base filler: rectilinear when solid, else the support base filler.
    let base_fill = |s: &Shapes| {
        if p.base_density > 0.95 {
            rect(s, p.spacing, p.base_density, p.angle)
        } else {
            crate::supportfill::support_base(s, p.spacing, p.base_density, p.angle, p.center)
        }
    };
    if !t.roof_first.is_empty() {
        let fill = |a: &Shapes| rect(a, p.spacing, p.interface_density, p.angle);
        interface.extend(perimeter_and_infill(&t.roof_first, 1, p.spacing, &fill));
    }
    if !t.roof.is_empty() {
        interface.extend(iface_fill(&t.roof, p.interface_density));
    }
    if !t.floor.is_empty() {
        interface.extend(iface_fill(&t.floor, p.bottom_density));
    }
    for a in &t.base {
        if p.on_bed {
            // A dense pad on the bed inside one loop (Orca's `fill_expolygons_with_sheath_generate_paths`).
            let ring = perimeters::offset(&a.shape, -u(0.5 * p.first_width));
            support.extend(draw_perimeters(&ring, p.first_spacing * SCALE * 0.15));
            let inner = perimeters::offset(&ring, -u(0.4 * p.first_spacing));
            support.extend(rect(&inner, p.first_spacing, p.first_density, p.angle));
            continue;
        }
        let need_infill = p.with_infill && (!p.default_pattern || a.infill);
        if need_infill {
            let support_spacing = p.spacing / p.base_density;
            let min_wall = u32::from(perimeters::offset(&a.shape, -u(support_spacing * 1.5)).is_empty());
            support.extend(perimeter_and_infill(
                &a.shape,
                min_wall.max(p.wall_count),
                p.spacing,
                &base_fill,
            ));
        } else {
            let double = if (a.extra_wall && p.wall_count == 0) || p.wall_count > 1 {
                0.1 / (SCALE * SCALE)
            } else if p.wall_count == 0 {
                0.25 * 25.0 * std::f64::consts::PI
            } else {
                f64::MAX
            };
            if let Some(r) = p.wide_fill {
                // Tree support infill: the base filler from half a spacing inside the innermost wall's center
                // line (where `perimeter_and_infill` starts it), in the parts wide enough for it.
                let mut centers = Vec::new();
                support.extend(branch_walls_around(
                    &a.shape,
                    p.width,
                    p.spacing,
                    double,
                    Some(&mut centers),
                ));
                let wide = wide_inside(&centers, 0.5 * p.spacing, r);
                if !wide.is_empty() && p.base_density > 0.0 {
                    support.extend(base_fill(&wide));
                }
            } else {
                support.extend(branch_walls(&a.shape, p.width, p.spacing, double));
            }
        }
    }
    (support, interface)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::treeclassic::{TreeArea, TreeLayer};

    fn circle(cx: f64, cy: f64, r: f64) -> Shapes {
        let ring: Vec<IntPoint<i32>> = (0..64)
            .map(|k| {
                let a = std::f64::consts::TAU * f64::from(k) / 64.0;
                IntPoint::new(u(cx + r * a.m_cos()), u(cy + r * a.m_sin()))
            })
            .collect();
        vec![vec![ring]]
    }

    #[test]
    fn a_small_circle_shrinks_to_nothing() {
        let c = circle(100.0, 100.0, 2.5);
        let o = perimeters::offset(&c, -u(4.3));
        assert!(o.is_empty(), "{:?}", perimeters::bounds(&o));
    }

    #[test]
    fn a_branch_with_infill_gets_a_wall() {
        let t = TreeLayer {
            base: vec![TreeArea {
                shape: circle(100.0, 100.0, 2.5),
                infill: false,
                extra_wall: false,
            }],
            ..TreeLayer::default()
        };
        let p = TreePathsIn {
            width: 0.42,
            spacing: 0.377,
            first_width: 0.42,
            first_spacing: 0.377,
            interface_density: 0.43,
            bottom_density: 0.43,
            base_density: 0.377 / 2.877,
            first_density: 0.9,
            angle: 0.0,
            interface_pattern: crate::config::InterfacePattern::Auto,
            interface_id: 0,
            wall_count: 0,
            with_infill: true,
            default_pattern: false,
            on_bed: false,
            anchor_max: 20.0,
            center: [100.0, 100.0],
            wide_fill: None,
        };
        let (s, _) = layer_paths(&t, &p);
        let closed = s.iter().filter(|q| q.len() > 3 && q.first() == q.last()).count();
        assert!(
            closed >= 1,
            "{:?}",
            s.iter()
                .map(|q| (q.len(), q.first(), q.last()))
                .collect::<Vec<_>>()
        );
    }

    /// The test layer inputs: the default base pattern, automatic walls, 2.5 mm base spacing.
    fn hollow_in(wide_fill: Option<f64>) -> TreePathsIn {
        TreePathsIn {
            width: 0.42,
            spacing: 0.377,
            first_width: 0.42,
            first_spacing: 0.377,
            interface_density: 0.43,
            bottom_density: 0.43,
            base_density: 0.377 / 2.877,
            first_density: 0.9,
            angle: 0.0,
            interface_pattern: crate::config::InterfacePattern::Auto,
            interface_id: 0,
            wall_count: 0,
            with_infill: false,
            default_pattern: true,
            on_bed: false,
            anchor_max: 20.0,
            center: [100.0, 100.0],
            wide_fill,
        }
    }

    fn base_of(shape: Shapes) -> TreeLayer {
        TreeLayer {
            base: vec![TreeArea {
                shape,
                infill: false,
                extra_wall: false,
            }],
            ..TreeLayer::default()
        }
    }

    /// The paths with tree support infill on (at a 2.877 mm pitch) less those with it off, after checking that the
    /// first ones begin with the second ones unchanged.
    fn added(t: &TreeLayer, on: &TreePathsIn) -> Vec<Path> {
        let off = TreePathsIn {
            wide_fill: None,
            ..on.clone()
        };
        let (a, ai) = layer_paths(t, on);
        let (b, bi) = layer_paths(t, &off);
        assert_eq!(ai, bi, "interface paths changed");
        assert!(a.len() >= b.len() && a[..b.len()] == b[..], "walls changed");
        a[b.len()..].to_vec()
    }

    fn mm(q: Point) -> (f64, f64) {
        (f64::from(q.x) / SCALE, f64::from(q.y) / SCALE)
    }

    #[test]
    fn a_wide_hollow_branch_gets_infill_inside_its_walls() {
        let t = base_of(circle(100.0, 100.0, 8.0));
        let fill = added(&t, &hollow_in(Some(2.877)));
        // About the inside's area over the 2.9 mm pitch: some 55 mm of lines.
        let long: f64 = fill
            .iter()
            .flat_map(|pl| pl.windows(2))
            .map(|w| f64::from(w[1].x - w[0].x).m_hypot(f64::from(w[1].y - w[0].y)) / SCALE)
            .sum();
        assert!(long > 35.0, "{long:.1} mm of fill");
        // Two walls (an 8 mm branch is over the double wall area): the inner one's center line at 8 - 1.5 widths,
        // the fill half a spacing inside it.
        let inside = 8.0 - 1.5 * 0.42 - 0.5 * 0.377;
        for q in fill.iter().flatten() {
            let (x, y) = mm(*q);
            let r = (x - 100.0).m_hypot(y - 100.0);
            assert!(
                r <= inside + 0.03,
                "fill point {r:.3} mm out, inside ends at {inside:.3}"
            );
        }
    }

    #[test]
    fn a_branch_at_its_own_size_stays_hollow() {
        let t = base_of(circle(100.0, 100.0, 2.5));
        assert!(added(&t, &hollow_in(Some(2.877))).is_empty());
    }

    #[test]
    fn a_thin_neck_between_wide_parts_gets_no_fill() {
        let bar: Shapes = vec![vec![vec![
            IntPoint::new(u(106.0), u(99.0)),
            IntPoint::new(u(124.0), u(99.0)),
            IntPoint::new(u(124.0), u(101.0)),
            IntPoint::new(u(106.0), u(101.0)),
        ]]];
        let shape = perimeters::union_all(&[&circle(100.0, 100.0, 8.0), &circle(130.0, 100.0, 8.0), &bar]);
        let fill = added(&base_of(shape), &hollow_in(Some(2.877)));
        assert!(!fill.is_empty());
        for q in fill.iter().flatten() {
            let (x, _) = mm(*q);
            assert!(!(110.0..120.0).contains(&x), "fill in the neck at x {x:.2}");
        }
    }

    #[test]
    fn tree_support_infill_leaves_roofs_floors_and_the_bed_pad_alone() {
        let t = TreeLayer {
            base: base_of(circle(100.0, 100.0, 8.0)).base,
            roof: circle(130.0, 100.0, 8.0),
            roof_first: circle(100.0, 130.0, 8.0),
            floor: circle(130.0, 130.0, 8.0),
        };
        let on = hollow_in(Some(2.877));
        // `added` checks the interface paths and the walls; the base gets its fill.
        assert!(!added(&t, &on).is_empty());
        let bed = TreePathsIn { on_bed: true, ..on };
        assert!(added(&t, &bed).is_empty());
    }

    #[test]
    fn filled_patterns_and_hybrid_normal_areas_ignore_tree_support_infill() {
        let on = hollow_in(Some(2.877));
        let rectilinear = TreePathsIn {
            with_infill: true,
            default_pattern: false,
            ..on.clone()
        };
        assert!(added(&base_of(circle(100.0, 100.0, 8.0)), &rectilinear).is_empty());
        let mut hybrid = base_of(circle(100.0, 100.0, 8.0));
        hybrid.base[0].infill = true;
        let hybrid_in = TreePathsIn {
            with_infill: true,
            ..on
        };
        assert!(added(&hybrid, &hybrid_in).is_empty());
    }

    #[test]
    fn a_pitch_wider_than_the_branch_adds_nothing() {
        let t = base_of(circle(100.0, 100.0, 8.0));
        assert!(added(&t, &hollow_in(Some(50.0))).is_empty());
    }

    /// A finely cut circle of radius `r`, as merged branch outlines come out of the wall offsets.
    fn dense_circle(r: f64) -> Shapes {
        let ring: Vec<IntPoint<i32>> = (0..4096)
            .map(|k| {
                let a = std::f64::consts::TAU * f64::from(k) / 4096.0;
                IntPoint::new(u(100.0 + r * a.m_cos()), u(100.0 + r * a.m_sin()))
            })
            .collect();
        vec![vec![ring]]
    }

    #[test]
    fn the_wide_test_on_dense_outlines_moves_by_at_most_its_tolerance() {
        let (inset, r) = (0.19, 2.88);
        // The disc test reads simplified outlines: 0.05 mm past the threshold still qualifies, 0.05 mm short of it
        // still does not.
        assert!(!wide_inside(&dense_circle(inset + r + 0.05), inset, r).is_empty());
        assert!(wide_inside(&dense_circle(inset + r - 0.05), inset, r).is_empty());
        // The fill stays inside the inset of the outline as drawn, and comes in by no more than the tolerance.
        let fill = wide_inside(&dense_circle(8.0), inset, r);
        let radii: Vec<f64> = fill
            .iter()
            .flatten()
            .flatten()
            .map(|q| (f64::from(q.x) / SCALE - 100.0).m_hypot(f64::from(q.y) / SCALE - 100.0))
            .collect();
        let edge = 8.0 - inset;
        let tol = 0.02;
        assert!(radii.iter().all(|&d| d <= edge + 0.003), "fill past the inset");
        assert!(
            radii.iter().all(|&d| d >= edge - tol - 0.003),
            "fill edge pulled in by more than the tolerance"
        );
    }
}
