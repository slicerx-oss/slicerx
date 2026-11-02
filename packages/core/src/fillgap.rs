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

/// A classic wall wedge at a sharp tip: the gap fill bead that runs down the tip's bisector between the two sides of a
/// wall loop, from near the tip into the body, getting wider as it goes.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Wedge {
    /// The bead's medial end, its point farthest from the tip, mm on the plate.
    end: (f64, f64),
    /// The bisector, a unit vector from the tip into the body.
    along: (f64, f64),
    /// How far the bead runs back toward the tip from `end`, mm.
    length: f64,
}

/// The wedges among a layer's wall gap fill `beads`: straight open beads at least [`WEDGE_MIN_MM`] long that widen
/// steadily from one end to the other, as the strip between the two sides of a wall does at a tip under 25 degrees.
pub(crate) fn tip_wedges<'a>(beads: impl IntoIterator<Item = &'a WallLine>) -> Vec<Wedge> {
    let at = |p: &IntPoint<i32>| {
        (
            f64::from(p.x) / crate::geom::SCALE,
            f64::from(p.y) / crate::geom::SCALE,
        )
    };
    let mut out = Vec::new();
    for bead in beads {
        if bead.closed || bead.points.len() < 2 || bead.widths.len() != bead.points.len() {
            continue;
        }
        let (Some(first), Some(last), Some(&w_first), Some(&w_last)) = (
            bead.points.first(),
            bead.points.last(),
            bead.widths.first(),
            bead.widths.last(),
        ) else {
            continue;
        };
        // From the narrow end to the wide one.
        let ((start, w0), (end, w1)) = if w_last >= w_first {
            ((at(first), w_first), (at(last), w_last))
        } else {
            ((at(last), w_last), (at(first), w_first))
        };
        let (dx, dy) = (end.0 - start.0, end.1 - start.1);
        let length = dx.m_hypot(dy);
        if length < WEDGE_MIN_MM {
            continue;
        }
        let along = (dx / length, dy / length);
        let straight = bead.points.iter().all(|p| {
            ((at(p).0 - start.0) * along.1 - (at(p).1 - start.1) * along.0).abs() <= WEDGE_STRAIGHT_MM
        });
        let (w0, w1) = (
            f64::from(w0) / crate::geom::SCALE,
            f64::from(w1) / crate::geom::SCALE,
        );
        // The half angle the bead widens at, which is the tip's.
        let half = ((w1 - w0) / 2.0 / length).m_atan().to_degrees();
        if straight && w1 >= WEDGE_WIDE_MM && (WEDGE_HALF_MIN_DEG..=WEDGE_HALF_MAX_DEG).contains(&half) {
            out.push(Wedge { end, along, length });
        }
    }
    out
}

/// Where a monotonic line surface meets a wedge's tip: a straight cut across the bisector, and the surface's two sides
/// beyond it. Positions u run along the bisector from the wedge's medial end, v across it (the normal turned a quarter
/// turn counterclockwise from the bisector), both mm.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TipCut {
    end: (f64, f64),
    along: (f64, f64),
    /// Where the surface ends, u.
    cut: f64,
    /// Where its lines end, u: 0.05 spacing past the cut.
    lines_end: f64,
    /// The surface's sides, v = a + b u, on the side of negative and of positive v.
    lo: (f64, f64),
    hi: (f64, f64),
    /// How far the wedge reaches back toward the tip, u (negative).
    back: f64,
    /// How far in from the surface's sides its lines end, mm across the bisector.
    inset: (f64, f64),
}

impl TipCut {
    /// `p` (mm) as u along the bisector and v across it.
    fn uv(&self, p: (f64, f64)) -> (f64, f64) {
        let (dx, dy) = (p.0 - self.end.0, p.1 - self.end.1);
        (
            dx * self.along.0 + dy * self.along.1,
            -dx * self.along.1 + dy * self.along.0,
        )
    }

    /// The plate point (mm) at `u` and `v`.
    fn point(&self, u: f64, v: f64) -> (f64, f64) {
        (
            self.end.0 + u * self.along.0 - v * self.along.1,
            self.end.1 + u * self.along.1 + v * self.along.0,
        )
    }

    /// The line-end boundary's two sides at `u`, v.
    fn ends_at(&self, u: f64) -> (f64, f64) {
        (
            self.lo.0 + self.lo.1 * u + self.inset.0,
            self.hi.0 + self.hi.1 * u - self.inset.1,
        )
    }
}

/// The tip cuts of a monotonic line surface `region` on Bambu Lab printers whose lines are `spacing_mm` apart: one at
/// each wedge whose tip the surface reaches. The surface ends half a spacing past the wedge's medial end, straight
/// across the bisector, so its lines end a further 0.05 spacing on (0.207 mm at the stock 0.42 mm lines and 0.2 mm
/// layers). A wedge the surface does not meet beyond its end, or meets with sides that do not open into the body,
/// gets none.
pub(crate) fn tip_cuts(region: &Shapes, wedges: &[Wedge], spacing_mm: f64) -> Vec<TipCut> {
    let mut out = Vec::new();
    for w in wedges {
        let mut cut = TipCut {
            end: w.end,
            along: w.along,
            cut: 0.5 * spacing_mm,
            lines_end: 0.55 * spacing_mm,
            lo: (0.0, 0.0),
            hi: (0.0, 0.0),
            back: -w.length,
            inset: (0.0, 0.0),
        };
        let across = (-w.along.1, w.along.0);
        let span = |u: f64| span_across(region, cut.point(u, 0.0), across);
        // The wedge's own strip holds no surface up to the cut.
        if span(0.0).is_some() || span(cut.cut - TIP_CLEAR_MM).is_some() {
            continue;
        }
        let us = [
            cut.cut + TIP_SIDE_NEAR_MM,
            cut.cut + TIP_SIDE_MID_MM,
            cut.cut + TIP_SIDE_FAR_MM,
        ];
        let [Some(a), Some(m), Some(b)] = us.map(span) else {
            continue;
        };
        let [ua, um, ub] = us;
        let fit = |va: f64, vb: f64| {
            let slope = (vb - va) / (ub - ua);
            (va - slope * ua, slope)
        };
        let (lo, hi) = (fit(a.0, b.0), fit(a.1, b.1));
        // Straight sides opening into the body, each at less than the steepest tip's half angle.
        let steep = WEDGE_HALF_MAX_DEG.to_radians().m_tan();
        let straight = (lo.0 + lo.1 * um - m.0).abs() <= TIP_SIDE_STRAIGHT_MM
            && (hi.0 + hi.1 * um - m.1).abs() <= TIP_SIDE_STRAIGHT_MM;
        let opens = (0.0..=steep).contains(&-lo.1) && (0.0..=steep).contains(&hi.1);
        let width = (hi.0 + hi.1 * cut.cut) - (lo.0 + lo.1 * cut.cut);
        if !straight || !opens || width < TIP_WIDTH_MIN_MM {
            continue;
        }
        let inset = |slope: f64| 0.05 * spacing_mm * (1.0 + slope * slope).sqrt();
        cut.lo = lo;
        cut.hi = hi;
        cut.inset = (inset(lo.1), inset(hi.1));
        out.push(cut);
    }
    out
}

/// `region` with each of `cuts` applied: the surface ends at the cut, straight across the bisector, between its two
/// sides carried on to it.
pub(crate) fn cut_tips(region: &Shapes, cuts: &[TipCut]) -> Shapes {
    let ring = |c: &TipCut, pts: &[(f64, f64)]| -> Vec<IntPoint<i32>> {
        pts.iter()
            .map(|&(u, v)| {
                let p = c.point(u, v);
                IntPoint::new(mm(p.0), mm(p.1))
            })
            .collect()
    };
    let mut front: Shapes = Vec::new();
    let mut fill: Shapes = Vec::new();
    for c in cuts {
        let side = |s: (f64, f64), u: f64| s.0 + s.1 * u;
        let (lo, hi) = (side(c.lo, c.cut), side(c.hi, c.cut));
        // Everything between the cut and the tip.
        let tip = c.back - TIP_CLEAR_MM;
        front.push(vec![ring(
            c,
            &[
                (tip, lo - TIP_CLEAR_MM),
                (c.cut, lo - TIP_CLEAR_MM),
                (c.cut, hi + TIP_CLEAR_MM),
                (tip, hi + TIP_CLEAR_MM),
            ],
        )]);
        // The surface from the cut to where its sides were measured.
        let far = c.cut + TIP_SIDE_NEAR_MM;
        fill.push(vec![ring(
            c,
            &[
                (c.cut, lo),
                (far, side(c.lo, far)),
                (far, side(c.hi, far)),
                (c.cut, hi),
            ],
        )]);
    }
    let kept = perimeters::difference(region, &front);
    perimeters::union_all(&[&kept, &fill])
}

/// How much room a line of a monotonic line surface needs from each of `cuts`: as much as it needs from the walls,
/// where its center keeps `inset_mm` in from `lines_in` (the surface, or the surface grown out along its walls, where
/// the lines are found). That is `inset_mm` less how far `lines_in` reaches past the surface's sides and less the 0.05
/// spacing from the surface's edge to where the lines end, mm from where the lines end.
pub(crate) fn tip_rooms(lines_in: &Shapes, cuts: &[TipCut], inset_mm: f64) -> Vec<f64> {
    cuts.iter()
        .map(|c| {
            let across = (-c.along.1, c.along.0);
            let side = |s: (f64, f64), u: f64| s.0 + s.1 * u;
            let square = |slope: f64| 1.0 / (1.0 + slope * slope).sqrt();
            let u = c.cut + TIP_SIDE_NEAR_MM;
            // Its outermost edge within a little of each of the surface's sides: it may hold strips apart from the
            // surface along the walls.
            let ts = crossings(lines_in, c.point(u, 0.0), across);
            let (lo, hi) = (side(c.lo, u), side(c.hi, u));
            let reach_lo = ts
                .iter()
                .filter(|&&t| t <= lo + TIP_CLEAR_MM && t >= lo - TIP_REACH_MAX_MM)
                .map(|t| (lo - t) * square(c.lo.1))
                .fold(0.0, f64::max);
            let reach_hi = ts
                .iter()
                .filter(|&&t| t >= hi - TIP_CLEAR_MM && t <= hi + TIP_REACH_MAX_MM)
                .map(|t| (t - hi) * square(c.hi.1))
                .fold(0.0, f64::max);
            inset_mm - reach_lo.min(reach_hi) - (c.lines_end - c.cut)
        })
        .collect()
}

/// Whether a line from `a` to `b` (mm on the plate) that ends at one of `cuts` has the room `rooms` gives that cut: a
/// point of it at least that far from the cut and from the line-end boundary's two sides.
pub(crate) fn tip_line_fits(cuts: &[TipCut], rooms: &[f64], a: (f64, f64), b: (f64, f64)) -> bool {
    cuts.iter().zip(rooms).any(|(c, &room)| {
        let (ua, va) = c.uv(a);
        let (ub, vb) = c.uv(b);
        let at_cut = |u: f64| (u - c.lines_end).abs() <= TIP_END_AT_CUT_MM;
        if !(at_cut(ua) || at_cut(ub)) || ua.max(ub) > c.lines_end + TIP_LINE_MAX_MM {
            return false;
        }
        let square = |slope: f64| 1.0 / (1.0 + slope * slope).sqrt();
        // The distances from the cut and from each side, square to it, at a point s of the way from a to b.
        let dists = |s: f64| {
            let (u, v) = (ua + s * (ub - ua), va + s * (vb - va));
            let (lo, hi) = c.ends_at(u);
            [
                u - c.lines_end,
                (v - lo) * square(c.lo.1),
                (hi - v) * square(c.hi.1),
            ]
        };
        let room_at = |s: f64| dists(s).into_iter().fold(f64::INFINITY, f64::min);
        // Each distance is linear along the line, so the most room is at an end or where two of them meet.
        let (d0, d1) = (dists(0.0), dists(1.0));
        let mut at = vec![0.0, 1.0];
        for i in 0..3 {
            for j in (i + 1)..3 {
                let (Some(&a0), Some(&a1), Some(&b0), Some(&b1)) =
                    (d0.get(i), d1.get(i), d0.get(j), d1.get(j))
                else {
                    continue;
                };
                let slope = (a1 - a0) - (b1 - b0);
                if slope.abs() > 1e-12 {
                    let s = (b0 - a0) / slope;
                    if (0.0..=1.0).contains(&s) {
                        at.push(s);
                    }
                }
            }
        }
        at.into_iter().any(|s| room_at(s) >= room)
    })
}

/// The tip lines of a monotonic line surface (`tips`, the lines [`tip_line_fits`] keeps, as spans in the chain's frame)
/// put into its chain `pls`, which was laid without them, so the chain's own lines keep their directions. Each goes
/// beside the chain line with the nearest end, on its side: just before it, ending at the end it starts from, when the
/// tip line's offset is lower (the side the chain comes from), else just after it, starting at the end it stops at. The
/// zigzag runs on through the tip line.
pub(crate) fn insert_tip_lines(
    pls: &mut Vec<Vec<Point>>,
    tips: &[crate::infill::Iv],
    spacing: i64,
    to_point: &dyn Fn(i64, i64) -> Point,
) {
    let f = |p: Point| (f64::from(p.x), f64::from(p.y));
    let (o, a) = (f(to_point(0, 0)), f(to_point(1_000_000, 0)));
    let across = (a.0 - o.0, a.1 - o.1);
    let norm = across.0 * across.0 + across.1 * across.1;
    // A point's line offset in the chain's frame.
    let offset = |p: Point| {
        let q = f(p);
        ((q.0 - o.0) * across.0 + (q.1 - o.1) * across.1) / norm * 1_000_000.0
    };
    let d = |p: Point, q: Point| {
        let (p, q) = (f(p), f(q));
        (p.0 - q.0).m_hypot(p.1 - q.1)
    };
    for tip in tips {
        let s = i64::from(tip.k) * spacing;
        let (lo, hi) = (to_point(s, tip.t0), to_point(s, tip.t1));
        let near = pls
            .iter()
            .enumerate()
            .filter_map(|(i, pl)| {
                let (first, last) = (*pl.first()?, *pl.last()?);
                let gap = [first, last]
                    .iter()
                    .flat_map(|&e| [d(e, lo), d(e, hi)])
                    .fold(f64::MAX, f64::min);
                Some((gap, i, first, last))
            })
            .min_by(|x, y| x.0.total_cmp(&y.0));
        let Some((_, i, first, last)) = near else {
            pls.push(vec![lo, hi]);
            continue;
        };
        let before = offset(lo) < offset(first);
        if before {
            // Ends at the end the neighbor starts from.
            let line = if d(hi, first) <= d(lo, first) {
                vec![lo, hi]
            } else {
                vec![hi, lo]
            };
            pls.insert(i, line);
        } else {
            // Starts at the end the neighbor stops at.
            let line = if d(lo, last) <= d(hi, last) {
                vec![lo, hi]
            } else {
                vec![hi, lo]
            };
            pls.insert(i + 1, line);
        }
    }
}

/// The caps of a monotonic line surface's tips on Bambu Lab printers. At each of `cuts` p is the gap from the point
/// where the lines end on the bisector to the nearest of `lines` (its stroke edge, for lines `width_mm` wide). With p
/// at least [`CAP_P_MIN`] mm the strip between the cut and the lines gets one bead across the bisector, from the
/// line-end boundary on one side to the other, its near side at the cut and [`CAP_NARROWER_MM`] narrower than p. From
/// [`CAP_BEND_P`] it turns at the side the lines leave open and follows that side in to [`CAP_BEND_REACH_MM`] past the
/// cut. Below that p gets none: no cap, rather than one the lines would print over.
pub(crate) fn tip_caps(
    cuts: &[TipCut],
    lines: &[[Point; 2]],
    width_mm: f64,
    layer_height: f64,
) -> Vec<WallLine> {
    let at = |p: Point| {
        (
            f64::from(p.x) / crate::geom::SCALE,
            f64::from(p.y) / crate::geom::SCALE,
        )
    };
    let to_segment = |q: (f64, f64), [a, b]: [Point; 2]| {
        let (a, b) = (at(a), at(b));
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 {
            (((q.0 - a.0) * dx + (q.1 - a.1) * dy) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (q.0 - a.0 - t * dx).m_hypot(q.1 - a.1 - t * dy)
    };
    let gap = |q: (f64, f64)| {
        lines
            .iter()
            .map(|l| to_segment(q, *l))
            .fold(f64::INFINITY, f64::min)
            - width_mm / 2.0
    };
    let flat = layer_height * (1.0 - std::f64::consts::FRAC_PI_4);
    let mut out = Vec::new();
    for c in cuts {
        let p = gap(c.point(c.lines_end, 0.0));
        if !p.is_finite() || p < CAP_P_MIN {
            continue;
        }
        let printed = p - CAP_NARROWER_MM;
        let u = c.lines_end + printed / 2.0;
        let (lo, hi) = c.ends_at(u);
        let (a, b) = (c.point(u, lo), c.point(u, hi));
        let mut points = vec![a, b];
        if p >= CAP_BEND_P {
            // The side the lines leave open goes last, and the bead turns in along it.
            let reach = c.lines_end + CAP_BEND_REACH_MM;
            let (lo_far, hi_far) = c.ends_at(reach);
            points = if gap(a) > gap(b) {
                vec![b, a, c.point(reach, lo_far)]
            } else {
                vec![a, b, c.point(reach, hi_far)]
            };
        }
        let w = mm(printed - flat);
        out.push(WallLine {
            inset: 0,
            is_odd: true,
            closed: false,
            points: points.iter().map(|&(x, y)| IntPoint::new(mm(x), mm(y))).collect(),
            widths: vec![w; points.len()],
        });
    }
    out
}

/// Where the line through `p` (mm) along the unit vector `dir` crosses the edges of `area` nearest `p` on either side,
/// as distances along `dir` (negative, then positive), when `p` lies inside it.
fn span_across(area: &Shapes, p: (f64, f64), dir: (f64, f64)) -> Option<(f64, f64)> {
    let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::INFINITY);
    let mut odd = false;
    let rel = |q: &IntPoint<i32>| {
        let (x, y) = (
            f64::from(q.x) / crate::geom::SCALE - p.0,
            f64::from(q.y) / crate::geom::SCALE - p.1,
        );
        // Along `dir`, and across it.
        (x * dir.0 + y * dir.1, -x * dir.1 + y * dir.0)
    };
    for ring in area.iter().flat_map(|s| s.iter()) {
        let n = ring.len();
        for i in 0..n {
            let (Some(a), Some(b)) = (ring.get(i), ring.get((i + 1) % n)) else {
                continue;
            };
            let (a, b) = (rel(a), rel(b));
            if (a.1 > 0.0) == (b.1 > 0.0) {
                continue;
            }
            let t = a.0 + (0.0 - a.1) / (b.1 - a.1) * (b.0 - a.0);
            if t < 0.0 {
                odd = !odd;
                lo = lo.max(t);
            } else {
                hi = hi.min(t);
            }
        }
    }
    (odd && lo.is_finite() && hi.is_finite()).then_some((lo, hi))
}

/// Where the line through `p` (mm) along the unit vector `dir` crosses the edges of `area`, as distances along `dir`.
fn crossings(area: &Shapes, p: (f64, f64), dir: (f64, f64)) -> Vec<f64> {
    let rel = |q: &IntPoint<i32>| {
        let (x, y) = (
            f64::from(q.x) / crate::geom::SCALE - p.0,
            f64::from(q.y) / crate::geom::SCALE - p.1,
        );
        (x * dir.0 + y * dir.1, -x * dir.1 + y * dir.0)
    };
    let mut out = Vec::new();
    for ring in area.iter().flat_map(|s| s.iter()) {
        let n = ring.len();
        for i in 0..n {
            let (Some(a), Some(b)) = (ring.get(i), ring.get((i + 1) % n)) else {
                continue;
            };
            let (a, b) = (rel(a), rel(b));
            if (a.1 > 0.0) != (b.1 > 0.0) {
                out.push(a.0 + (0.0 - a.1) / (b.1 - a.1) * (b.0 - a.0));
            }
        }
    }
    out
}

/// The shortest wedge, mm.
const WEDGE_MIN_MM: f64 = 0.5;
/// How far a wedge's points may stray from the line between its ends, mm.
const WEDGE_STRAIGHT_MM: f64 = 0.02;
/// The narrowest a wedge's wide end may be, mm.
const WEDGE_WIDE_MM: f64 = 0.25;
/// The half angles a wedge may widen at, degrees: tips up to 25 degrees.
const WEDGE_HALF_MIN_DEG: f64 = 1.0;
const WEDGE_HALF_MAX_DEG: f64 = 12.5;
/// How clear of the surface the wedge's strip must be short of the cut, and the margin round what the cut takes away,
/// mm.
const TIP_CLEAR_MM: f64 = 0.05;
/// Where past the cut the surface's sides are measured, mm.
const TIP_SIDE_NEAR_MM: f64 = 0.15;
const TIP_SIDE_MID_MM: f64 = 0.275;
const TIP_SIDE_FAR_MM: f64 = 0.4;
/// How far the surface's side may stray from a straight line there, mm.
const TIP_SIDE_STRAIGHT_MM: f64 = 0.01;
/// How far from the line-end boundary at the cut a line's end may sit and still end there, and the longest line between
/// a wall and the cut along the bisector, mm.
const TIP_END_AT_CUT_MM: f64 = 0.01;
const TIP_LINE_MAX_MM: f64 = 1.5;
/// The farthest past the surface's side the area its lines are found in may reach, mm.
const TIP_REACH_MAX_MM: f64 = 0.1;
/// The narrowest the surface may be at the cut, mm.
const TIP_WIDTH_MIN_MM: f64 = 0.1;
/// The smallest gap p that gets a cap, mm.
const CAP_P_MIN: f64 = 0.123;
/// How much narrower than p the cap prints, mm.
const CAP_NARROWER_MM: f64 = 0.021;
/// From this p (mm) the cap turns in along the open side.
const CAP_BEND_P: f64 = 0.15;
/// How far past the line ends the turned cap reaches, mm.
const CAP_BEND_REACH_MM: f64 = 0.215;

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
