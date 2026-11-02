// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Gap fill of the fill itself (`gap_fill_target`): after a top, bottom or solid surface is filled, the
//! strips between its lines and the edge that the lines did not cover get a variable-width bead down their
//! middle. This is our own implementation of what Orca's `Fill::_create_gap_fill` (`Fill/FillBase.cpp`) does.

use crate::arachne::WallLine;
use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::{Point, mm};
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// Which surfaces get gap fill: `topbottom` (the top and bottom surfaces) or `everywhere` (also the
/// internal solid infill); Orca's default is `nowhere`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    Nowhere,
    TopBottom,
    Everywhere,
}

pub(crate) fn target(cfg: &PrintConfig) -> Target {
    match cfg.raw.get("gap_fill_target") {
        Some(serde_json::Value::String(s)) => match s.as_str() {
            "everywhere" => Target::Everywhere,
            "topbottom" => Target::TopBottom,
            _ => Target::Nowhere,
        },
        _ => Target::Nowhere,
    }
}

/// The gap beads for one filled surface. `area` is the surface without the growth that lets lines overlap
/// the walls, `lines` the fill segments that were laid and `spacing_mm` their pitch.
pub(crate) fn gaps(area: &Shapes, lines: &[[Point; 2]], spacing_mm: f64, cfg: &PrintConfig) -> Vec<WallLine> {
    let filter = crate::motion::raw_f(cfg, "filter_out_gap_fill").unwrap_or(0.0);
    // Strips between 0.2 spacings (less the squish tolerance) and 2 spacings wide.
    let bounds = Bounds {
        min: 0.2 * spacing_mm * (1.0 - 0.4),
        max: 2.0 * spacing_mm,
        filter,
        thin: false,
    };
    strips_of(area, lines, spacing_mm, &bounds)
}

/// The gap beads of a surface filled with monotonic line: every sliver its own lines leave, whatever
/// `gap_fill_target` says, and `filter_out_gap_fill` does not apply. The slivers run from 0.05 spacing up to
/// `widest_mm` wide, and no bead is shorter than [`SHORT_MIN_MM`]. A sliver too short for a line down its middle (a
/// corner the lines cut off) gets none. A piece of `area` no line crosses (a narrow strip where no line of the grid
/// fits) is a sliver of its own up to two spacings wide.
pub(crate) fn line_gaps(
    area: &Shapes,
    lines: &[[Point; 2]],
    spacing_mm: f64,
    widest_mm: f64,
) -> Vec<WallLine> {
    let bounds = Bounds {
        min: 0.05 * spacing_mm,
        max: widest_mm,
        filter: SHORT_MIN_MM,
        thin: true,
    };
    let (bare, lined): (Shapes, Shapes) = area.iter().cloned().partition(|piece| !crossed(piece, lines));
    if bare.is_empty() {
        return strips_of(area, lines, spacing_mm, &bounds);
    }
    let mut out = strips_of(&lined, lines, spacing_mm, &bounds);
    let bare_bounds = Bounds {
        max: widest_mm.max(2.0 * spacing_mm),
        ..bounds
    };
    out.extend(beads_of(&bare, &bare_bounds));
    out
}

/// What the corner pass decides for one monotonic line surface on Bambu Lab printers: the corner beads it prints, and
/// the corners (on the plate) where the strip pass's own pieces are dropped ([`drop_corner_pieces`]) because the
/// corner rule, not the strip's medial axis, decides what prints there.
#[derive(Default)]
pub(crate) struct Corners {
    pub(crate) beads: Vec<WallLine>,
    pub(crate) quiet: Vec<Point>,
}

/// The corner beads of a monotonic line surface on Bambu Lab printers. At a corner of `ends_area` (where the line ends
/// sit) whose bisector runs along the lines (a run-in corner), two lines end, one on each wall. From the corner to the
/// nearest line end on each wall are the legs, a the shorter and b the longer, and u is how far the shorter leg's line
/// end sits from the corner across the lines. When those two lines are linked in the chain (`links`: a line's last
/// point and the next line's first point), the turn between them fills the corner and it gets no bead. At a run-in
/// corner of [`CORNER_ANGLE_MIN_DEG`] to [`CORNER_ANGLE_MAX_DEG`] whose lines are not linked and whose u is w / 2 less
/// [`CORNER_U_FROM_HALF_MAX`] to w / 2 less [`CORNER_U_FROM_HALF_MIN`] (0.107 to 0.150 mm at w 0.42), for line width
/// w `width_mm`, the corner gets one straight bead along the longer leg's wall, about
/// 1.73 u - 0.10 mm wide; any other run-in corner in that range gets none. Those corners, the linked run-in tips down
/// to [`TIP_ANGLE_MIN_DEG`] and the corners a line cuts across (bisector across the lines, [`CUT_ANGLE_MIN_DEG`] to
/// [`CUT_ANGLE_MAX_DEG`]) get nothing from the strip pass either: they are listed in [`Corners::quiet`]. `lines` holds
/// each line's first and last point in print order and `along` is the lines' direction.
pub(crate) fn corner_beads(
    ends_area: &Shapes,
    lines: &[[Point; 2]],
    links: &[[Point; 2]],
    along: (f64, f64),
    width_mm: f64,
    layer_height: f64,
) -> Corners {
    let to_mm = |p: Point| {
        (
            f64::from(p.x) / crate::geom::SCALE,
            f64::from(p.y) / crate::geom::SCALE,
        )
    };
    let ends: Vec<(usize, (f64, f64), Point)> = lines
        .iter()
        .enumerate()
        .flat_map(|(i, l)| l.iter().map(move |p| (i, to_mm(*p), *p)))
        .collect();
    let linked = |p: Point, q: Point| {
        links.iter().any(|&[a, b]| {
            let (fa, fb) = (to_mm(a), to_mm(b));
            (fa.0 - fb.0).m_hypot(fa.1 - fb.1) < LINK_MAX_MM && ((a == p && b == q) || (a == q && b == p))
        })
    };
    let at_mm = |(x, y): (f64, f64)| IntPoint::new(mm(x), mm(y));
    let flat = layer_height * (1.0 - std::f64::consts::FRAC_PI_4);
    let run_in_tilt = RUN_IN_TOL_DEG.to_radians().m_sin();
    let cut_tilt = CUT_TOL_DEG.to_radians().m_cos();
    let mut out = Corners::default();
    for shape in ends_area {
        for raw in shape {
            let ring = perimeters::simplify_ring(raw, 5);
            for (v, prev, next, beveled) in ring_corners(&ring) {
                let walls = [prev, next].map(|q| {
                    let len = (q.0 - v.0).m_hypot(q.1 - v.1);
                    (((q.0 - v.0) / len, (q.1 - v.1) / len), len)
                });
                let [(u1, l1), (u2, l2)] = walls;
                if l1 < CORNER_WALL_MIN_MM || l2 < CORNER_WALL_MIN_MM {
                    continue;
                }
                let angle = (u1.0 * u2.0 + u1.1 * u2.1).clamp(-1.0, 1.0).m_acos().to_degrees();
                // The line ends' boundary cuts only sharp corners off; a cut-off corner at the rule's angles or
                // wider is a rounded or chamfered corner of the part, which the strip pass fills as before.
                if beveled && angle >= CORNER_ANGLE_MIN_DEG {
                    continue;
                }
                let half = (u1.0 + u2.0).m_hypot(u1.1 + u2.1);
                if half < 1e-9 {
                    continue;
                }
                let bis = ((u1.0 + u2.0) / half, (u1.1 + u2.1) / half);
                // The surface inside the corner (a convex corner of the surface), past the cut of a beveled one.
                let reach = if beveled { BEVEL_MAX_MM * 2.0 } else { 0.02 };
                let probe = at_mm((v.0 + reach * bis.0, v.1 + reach * bis.1));
                if !crate::support::point_in(ends_area, probe.x, probe.y) {
                    continue;
                }
                let corner = {
                    let at = at_mm(v);
                    Point::new(at.x, at.y)
                };
                // A corner a line cuts across: the strip pass leaves it empty too.
                if (bis.0 * along.1 - bis.1 * along.0).abs() >= cut_tilt {
                    if (CUT_ANGLE_MIN_DEG..=CUT_ANGLE_MAX_DEG).contains(&angle) {
                        out.quiet.push(corner);
                    }
                    continue;
                }
                let rule = (CORNER_ANGLE_MIN_DEG..=CORNER_ANGLE_MAX_DEG).contains(&angle);
                if (bis.0 * along.1 - bis.1 * along.0).abs() > run_in_tilt
                    || !(rule || (TIP_ANGLE_MIN_DEG..CORNER_ANGLE_MIN_DEG).contains(&angle))
                {
                    continue;
                }
                // The nearest line end on each wall.
                let nearest = |u: (f64, f64), len: f64| {
                    ends.iter()
                        .filter_map(|&(k, p, at)| {
                            let (dx, dy) = (p.0 - v.0, p.1 - v.1);
                            let leg = dx * u.0 + dy * u.1;
                            let off = (dx * u.1 - dy * u.0).abs();
                            (off <= END_ON_WALL_MM && leg > -END_ON_WALL_MM && leg < len)
                                .then_some((leg, k, at, p))
                        })
                        .min_by(|a, b| a.0.total_cmp(&b.0))
                };
                let (Some(h1), Some(h2)) = (nearest(u1, l1), nearest(u2, l2)) else {
                    continue;
                };
                if h1.1 == h2.1 {
                    continue;
                }
                let joined = linked(h1.2, h2.2);
                if !rule {
                    // A sharper run-in tip: quiet only when its lines are linked; a free one keeps its strip pieces.
                    if joined {
                        out.quiet.push(corner);
                    }
                    continue;
                }
                out.quiet.push(corner);
                if joined {
                    continue;
                }
                // Along the longer leg's wall, from beside the corner.
                let (short, (wall, b)) = if h1.0 >= h2.0 {
                    (h2, (u1, h1.0))
                } else {
                    (h1, (u2, h2.0))
                };
                let lateral = ((short.3.0 - v.0) * along.1 - (short.3.1 - v.1) * along.0).abs();
                let window =
                    (width_mm / 2.0 - CORNER_U_FROM_HALF_MAX)..=(width_mm / 2.0 - CORNER_U_FROM_HALF_MIN);
                if !window.contains(&lateral) {
                    continue;
                }
                let w = 1.73 * lateral - 0.100 - flat;
                if w <= 0.0 {
                    continue;
                }
                // Into the surface, square to the wall.
                let side = wall.0 * bis.1 - wall.1 * bis.0;
                let inward = if side >= 0.0 {
                    (-wall.1, wall.0)
                } else {
                    (wall.1, -wall.0)
                };
                // The near end sits 0.55 u - 0.041 from the corner, 0.69 u - 0.067 in from the wall; the far end
                // 1.94 u - 0.22 in, for a bead b + 0.21 - 1.70 u long.
                let (near_in, far_in) = (0.69 * lateral - 0.067, 1.94 * lateral - 0.220);
                let from_corner = (0.55 * lateral - 0.041).max(near_in.abs());
                let from = (from_corner * from_corner - near_in * near_in).max(0.0).sqrt();
                let length = b + 0.21 - 1.70 * lateral;
                let run = (length * length - (far_in - near_in) * (far_in - near_in))
                    .max(0.0)
                    .sqrt();
                let near = (
                    v.0 + from * wall.0 + near_in * inward.0,
                    v.1 + from * wall.1 + near_in * inward.1,
                );
                let far = (
                    v.0 + (from + run) * wall.0 + far_in * inward.0,
                    v.1 + (from + run) * wall.1 + far_in * inward.1,
                );
                out.beads.push(WallLine {
                    inset: 0,
                    is_odd: true,
                    closed: false,
                    points: vec![at_mm(near), at_mm(far)],
                    widths: vec![mm(w); 2],
                });
            }
        }
    }
    out
}

/// A corner of a ring (mm): the corner, the point before it, the point after it and whether the ring cuts it off.
type RingCorner = ((f64, f64), (f64, f64), (f64, f64), bool);

/// The convex and concave corners of a ring of the line ends' boundary as (corner, the point before, the point
/// after, beveled), mm. Where the boundary cuts a sharp corner off with edges shorter than [`BEVEL_MAX_MM`], the
/// corner is where the two long walls beside them meet.
fn ring_corners(ring: &[IntPoint<i32>]) -> Vec<RingCorner> {
    let pts: Vec<(f64, f64)> = ring
        .iter()
        .map(|p| {
            (
                f64::from(p.x) / crate::geom::SCALE,
                f64::from(p.y) / crate::geom::SCALE,
            )
        })
        .collect();
    let n = pts.len();
    if n < 3 {
        return Vec::new();
    }
    let at = |i: usize| pts.get(i % n).copied().unwrap_or((0.0, 0.0));
    let long = |i: usize| {
        let (p, q) = (at(i), at(i + 1));
        (q.0 - p.0).m_hypot(q.1 - p.1) >= BEVEL_MAX_MM
    };
    let Some(first) = (0..n).find(|&i| long(i)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut i = first;
    loop {
        // The next long edge after edge i, and the short ones between.
        let mut j = i + 1;
        while !long(j) {
            j += 1;
        }
        let (a0, a1, b0, b1) = (at(i), at(i + 1), at(j), at(j + 1));
        if j == i + 1 {
            out.push((a1, a0, b1, false));
        } else {
            let (da, db) = ((a1.0 - a0.0, a1.1 - a0.1), (b1.0 - b0.0, b1.1 - b0.1));
            let cross = da.0 * db.1 - da.1 * db.0;
            if cross.abs() > 1e-12 {
                let t = ((b0.0 - a0.0) * db.1 - (b0.1 - a0.1) * db.0) / cross;
                let v = (a0.0 + t * da.0, a0.1 + t * da.1);
                if (v.0 - a1.0).m_hypot(v.1 - a1.1) <= 2.0 * BEVEL_MAX_MM {
                    out.push((v, a0, b1, true));
                }
            }
        }
        if j >= first + n {
            break;
        }
        i = j;
        if i >= first + n {
            break;
        }
    }
    out
}

/// Drops the strip pass's pieces (`beads`, from [`line_gaps`]) that reach within [`QUIET_NEAR_MM`] of one of the
/// `quiet` corners and lie wholly within [`QUIET_REACH_MM`] of it. A sliver running along a wall past the corner keeps
/// its bead.
pub(crate) fn drop_corner_pieces(beads: &mut Vec<WallLine>, quiet: &[Point]) {
    if quiet.is_empty() {
        return;
    }
    let to_mm = |x: i32, y: i32| {
        (
            f64::from(x) / crate::geom::SCALE,
            f64::from(y) / crate::geom::SCALE,
        )
    };
    let near_segment = |c: (f64, f64), a: (f64, f64), b: (f64, f64)| {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 {
            (((c.0 - a.0) * dx + (c.1 - a.1) * dy) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (c.0 - a.0 - t * dx).m_hypot(c.1 - a.1 - t * dy)
    };
    beads.retain(|bead| {
        let pts: Vec<(f64, f64)> = bead.points.iter().map(|p| to_mm(p.x, p.y)).collect();
        !quiet.iter().any(|q| {
            let c = to_mm(q.x, q.y);
            let within = pts
                .iter()
                .all(|p| (p.0 - c.0).m_hypot(p.1 - c.1) <= QUIET_REACH_MM);
            let touches = match pts.as_slice() {
                [only] => (only.0 - c.0).m_hypot(only.1 - c.1) <= QUIET_NEAR_MM,
                _ => pts
                    .windows(2)
                    .any(|w| matches!(w, [a, b] if near_segment(c, *a, *b) <= QUIET_NEAR_MM)),
            };
            within && touches
        })
    });
}

/// The corner angles (degrees) where the bead rule decides a run-in corner.
const CORNER_ANGLE_MIN_DEG: f64 = 74.0;
const CORNER_ANGLE_MAX_DEG: f64 = 106.0;
/// Below the bead rule's angles, run-in tips down to this angle (degrees) get nothing when their lines are linked.
const TIP_ANGLE_MIN_DEG: f64 = 55.0;
/// The range of u where a free run-in corner gets a bead, as how far it sits under half the line width (mm); out of it
/// there is none.
const CORNER_U_FROM_HALF_MIN: f64 = 0.060;
const CORNER_U_FROM_HALF_MAX: f64 = 0.103;
/// How far a run-in corner's bisector may sit from the lines' direction, degrees.
const RUN_IN_TOL_DEG: f64 = 3.0;
/// How far a cut corner's bisector may sit from square across the lines, degrees, and the angles (degrees) of the cut
/// corners that get nothing.
const CUT_TOL_DEG: f64 = 10.0;
const CUT_ANGLE_MIN_DEG: f64 = 40.0;
const CUT_ANGLE_MAX_DEG: f64 = 110.0;
/// A strip piece is dropped at a quiet corner when it comes this close to it (mm) and lies wholly within
/// [`QUIET_REACH_MM`] of it.
const QUIET_NEAR_MM: f64 = 0.2;
const QUIET_REACH_MM: f64 = 0.8;
/// Boundary edges shorter than this (mm) are a bevel across a sharp corner, not a wall.
const BEVEL_MAX_MM: f64 = 0.15;
/// The shortest wall on either side of a corner the pass looks at, mm.
const CORNER_WALL_MIN_MM: f64 = 0.6;
/// How far a line end may sit from the wall it ends on, mm.
const END_ON_WALL_MM: f64 = 0.01;
/// The longest travel that links two line ends at a corner, mm.
const LINK_MAX_MM: f64 = 0.6;

/// Whether any of `lines` has its middle or an end in `piece`.
fn crossed(piece: &[Vec<i_overlay::i_float::int::point::IntPoint<i32>>], lines: &[[Point; 2]]) -> bool {
    let Some(ring) = piece.first() else {
        return false;
    };
    let (mut lo, mut hi) = ([i32::MAX; 2], [i32::MIN; 2]);
    for p in ring {
        lo = [lo[0].min(p.x), lo[1].min(p.y)];
        hi = [hi[0].max(p.x), hi[1].max(p.y)];
    }
    let one: Shapes = vec![piece.to_vec()];
    lines.iter().any(|[a, b]| {
        [
            *a,
            *b,
            Point::new(i32::midpoint(a.x, b.x), i32::midpoint(a.y, b.y)),
        ]
        .iter()
        .any(|p| {
            (lo[0]..=hi[0]).contains(&p.x)
                && (lo[1]..=hi[1]).contains(&p.y)
                && crate::support::point_in(&one, p.x, p.y)
        })
    })
}

/// Which strips get a bead: `min` to `max` mm wide, at least `filter` mm long, and whether close points are
/// dropped from the beads ([`thin_out`]).
struct Bounds {
    min: f64,
    max: f64,
    filter: f64,
    thin: bool,
}

/// The shortest monotonic line gap bead, mm.
const SHORT_MIN_MM: f64 = 0.1;

fn strips_of(area: &Shapes, lines: &[[Point; 2]], spacing_mm: f64, bounds: &Bounds) -> Vec<WallLine> {
    if area.is_empty() || lines.is_empty() {
        return Vec::new();
    }
    // The part the lines leave open: what is more than half a spacing (plus a hair) from every line.
    let polylines: Vec<Vec<Point>> = lines.iter().map(|s| s.to_vec()).collect();
    let covered = crate::support::stroke(&polylines, 0.5 * spacing_mm + 10.0 / crate::geom::SCALE);
    let open = perimeters::difference(area, &covered);
    if open.is_empty() {
        return Vec::new();
    }
    let open = perimeters::intersection(&perimeters::union_all(&[&open]), area);
    if open.is_empty() {
        return Vec::new();
    }
    beads_of(&open, bounds)
}

/// The beads of the part `open` of a surface the lines leave: down the middle of every strip of it within `bounds`.
fn beads_of(open: &Shapes, bounds: &Bounds) -> Vec<WallLine> {
    if open.is_empty() {
        return Vec::new();
    }
    let (min, max) = (bounds.min, bounds.max);
    let opened = perimeters::offset(&perimeters::offset(open, -mm(min / 2.0)), mm(min / 2.0));
    let wide = perimeters::offset(&perimeters::offset(open, -mm(max / 2.0)), mm(max / 2.0) + 10);
    let strips = perimeters::difference(&opened, &wide);
    let mut out = Vec::new();
    for shape in &strips {
        // Orca simplifies the strip by a tenth of the resolution first.
        let simple: Shapes = vec![
            shape
                .iter()
                .map(|r| perimeters::simplify_ring(r, 12))
                .filter(|r| r.len() >= 3)
                .collect(),
        ];
        let mut beads = crate::arachne::medial_lines(&simple, min, max);
        if bounds.thin {
            beads.iter_mut().for_each(thin_out);
        }
        for line in beads {
            let len: f64 = line
                .points
                .windows(2)
                .map(|w| match w {
                    [a, b] => f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y)) / crate::geom::SCALE,
                    _ => 0.0,
                })
                .sum();
            if len >= bounds.filter {
                out.push(line);
            }
        }
    }
    out
}

/// Drops the points of a bead closer than [`STEP_MIN_MM`] to the one kept before them (the last point stays), so no
/// piece of it is too short to be written as a move.
fn thin_out(line: &mut WallLine) {
    let step = mm(STEP_MIN_MM);
    let n = line.points.len();
    let mut keep: Vec<usize> = Vec::with_capacity(n);
    for (i, p) in line.points.iter().enumerate() {
        let far = |k: &usize| {
            line.points
                .get(*k)
                .is_some_and(|q| f64::from(p.x - q.x).m_hypot(f64::from(p.y - q.y)) >= f64::from(step))
        };
        match keep.last() {
            None => keep.push(i),
            Some(k) if far(k) => keep.push(i),
            Some(_) if i + 1 == n => {
                // The last point replaces a kept one too close to it, unless that is the first.
                if keep.len() > 1 {
                    keep.pop();
                }
                keep.push(i);
            }
            Some(_) => {}
        }
    }
    if keep.len() == n {
        return;
    }
    line.points = keep.iter().filter_map(|&k| line.points.get(k).copied()).collect();
    line.widths = keep.iter().filter_map(|&k| line.widths.get(k).copied()).collect();
}

/// The closest two points of a monotonic line gap bead may be, mm.
const STEP_MIN_MM: f64 = 0.02;

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(w_mm: f64, h_mm: f64) -> Shapes {
        let (w, h) = (mm(w_mm), mm(h_mm));
        vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(w, 0),
            IntPoint::new(w, h),
            IntPoint::new(0, h),
        ]]]
    }

    #[test]
    fn strips_beside_a_line_get_a_bead_each() {
        let cfg = PrintConfig::default();
        let sp = 0.4;
        // One line down the middle of a surface 2.6 spacings wide leaves 0.8 spacings on each side.
        let area = rect(10.0, 2.6 * sp);
        let y = mm(1.3 * sp);
        let line = [Point::new(0, y), Point::new(mm(10.0), y)];
        let beads = gaps(&area, &[line], sp, &cfg);
        assert_eq!(beads.len(), 2, "{} beads", beads.len());
        // Each bead is as wide as its strip, 0.8 spacings.
        let widest = beads
            .iter()
            .flat_map(|b| b.widths.iter())
            .copied()
            .max()
            .unwrap_or(0);
        assert!(
            (f64::from(widest) / crate::geom::SCALE - 0.8 * sp).abs() < 0.05,
            "{widest}"
        );
    }

    /// A corner 0.72 mm on a side whose last line runs across it: the sliver it leaves is too short for a line
    /// down its middle, so neither the target's gap fill nor monotonic line puts a bead in it.
    #[test]
    fn a_corner_the_lines_cut_off_gets_no_bead() {
        let cfg = PrintConfig::default();
        let sp = 0.377;
        let c = mm(0.72);
        let area: Shapes = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(c, 0),
            IntPoint::new(0, c),
        ]]];
        let line = [
            Point::new(c + mm(1.0), -mm(1.0)),
            Point::new(-mm(1.0), c + mm(1.0)),
        ];
        assert!(gaps(&area, &[line], sp, &cfg).is_empty());
        assert!(line_gaps(&area, &[line], sp, sp).is_empty());
    }

    #[test]
    fn monotonic_line_beads_are_no_wider_than_the_cap() {
        let sp = 0.4;
        // One line down the middle of a surface 2.6 spacings wide leaves 0.8 spacings on each side.
        let area = rect(10.0, 2.6 * sp);
        let y = mm(1.3 * sp);
        let line = [Point::new(0, y), Point::new(mm(10.0), y)];
        assert_eq!(line_gaps(&area, &[line], sp, sp).len(), 2);
        // With a cap under the strips' width they are left open.
        assert!(line_gaps(&area, &[line], sp, 0.25).is_empty());
    }

    #[test]
    fn a_surface_the_lines_cover_has_no_gap() {
        let cfg = PrintConfig::default();
        let sp = 0.4;
        let area = rect(10.0, sp);
        let y = mm(0.5 * sp);
        let line = [Point::new(0, y), Point::new(mm(10.0), y)];
        assert!(gaps(&area, &[line], sp, &cfg).is_empty());
    }
}
