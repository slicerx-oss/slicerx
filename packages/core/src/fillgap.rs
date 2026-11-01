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

/// The corner beads of a monotonic line surface on Bambu Lab printers. At a right-angle corner of `ends_area` (where
/// the line ends sit) whose bisector runs along the lines, two lines end one on each wall. From the corner to the
/// nearest line end on each wall are the legs, a the shorter and b the longer. When those two
/// lines are linked in the chain (`links`: a line's last point and the next line's first point), the turn between them
/// fills the corner and it gets no bead. When they are not and the pocket the shorter leg leaves, e = w / sqrt(2) - a
/// for line width `width_mm`, is [`CORNER_E_MIN`] to [`CORNER_E_MAX`] mm, the corner gets one straight bead along the
/// longer leg's wall, about a - 0.06 mm wide. `lines` holds each line's first and last point in print order and
/// `along` is the lines' direction. Every other corner (cut by a line, at another angle, or with e out of that range)
/// gets none.
pub(crate) fn corner_beads(
    ends_area: &Shapes,
    lines: &[[Point; 2]],
    links: &[[Point; 2]],
    along: (f64, f64),
    width_mm: f64,
    layer_height: f64,
) -> Vec<WallLine> {
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
    let tilt = CORNER_ANGLE_TOL_DEG.to_radians().m_sin();
    let mut out = Vec::new();
    for shape in ends_area {
        for raw in shape {
            let ring = perimeters::simplify_ring(raw, 5);
            let n = ring.len();
            if n < 3 {
                continue;
            }
            for i in 0..n {
                let (Some(&pv), Some(&pp), Some(&pn)) =
                    (ring.get(i), ring.get((i + n - 1) % n), ring.get((i + 1) % n))
                else {
                    continue;
                };
                let v = to_mm(Point::new(pv.x, pv.y));
                let walls = [pp, pn].map(|q| {
                    let q = to_mm(Point::new(q.x, q.y));
                    let len = (q.0 - v.0).m_hypot(q.1 - v.1);
                    (((q.0 - v.0) / len, (q.1 - v.1) / len), len)
                });
                let [(u1, l1), (u2, l2)] = walls;
                if l1 < CORNER_WALL_MIN_MM || l2 < CORNER_WALL_MIN_MM {
                    continue;
                }
                // A right angle whose bisector runs along the lines, and the surface inside it.
                if (u1.0 * u2.0 + u1.1 * u2.1).abs() > tilt {
                    continue;
                }
                let half = (u1.0 + u2.0).m_hypot(u1.1 + u2.1);
                let bis = ((u1.0 + u2.0) / half, (u1.1 + u2.1) / half);
                if (bis.0 * along.1 - bis.1 * along.0).abs() > tilt {
                    continue;
                }
                let probe = at_mm((v.0 + 0.02 * bis.0, v.1 + 0.02 * bis.1));
                if !crate::support::point_in(ends_area, probe.x, probe.y) {
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
                                .then_some((leg, k, at))
                        })
                        .min_by(|a, b| a.0.total_cmp(&b.0))
                };
                let (Some(h1), Some(h2)) = (nearest(u1, l1), nearest(u2, l2)) else {
                    continue;
                };
                if h1.1 == h2.1 {
                    continue;
                }
                let (a, b) = (h1.0.min(h2.0), h1.0.max(h2.0));
                let e = std::f64::consts::FRAC_1_SQRT_2 * width_mm - a;
                if !(CORNER_E_MIN..=CORNER_E_MAX).contains(&e) {
                    continue;
                }
                if linked(h1.2, h2.2) {
                    continue;
                }
                // Along the longer leg's wall, from beside the corner; the other wall is the way in.
                let (u, inward) = if h1.0 >= h2.0 { (u1, u2) } else { (u2, u1) };
                let wide = a >= CORNER_WIDE_LEG_MM;
                let printed = a - if wide { 0.05 } else { 0.062 };
                let w = printed - flat;
                if w <= 0.0 {
                    continue;
                }
                let near = (
                    v.0 + 0.025 * u.0 + 0.013 * inward.0,
                    v.1 + 0.025 * u.1 + 0.013 * inward.1,
                );
                let far = if wide {
                    // The far end sits 0.065 mm in from the wall and the bead is b - 0.05 long.
                    let len = b - 0.05;
                    let rise = 0.065 - 0.013;
                    let run = (len * len - rise * rise).max(0.0).sqrt();
                    (
                        near.0 + run * u.0 + rise * inward.0,
                        near.1 + run * u.1 + rise * inward.1,
                    )
                } else {
                    (near.0 + (b + 0.005) * u.0, near.1 + (b + 0.005) * u.1)
                };
                out.push(WallLine {
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

/// The range of e (mm) where a free right-angle corner of a monotonic line surface gets a bead; out of it there is
/// none.
const CORNER_E_MIN: f64 = 0.089;
const CORNER_E_MAX: f64 = 0.143;
/// How far from a right angle, and from the lines' direction for its bisector, a beaded corner may be, degrees.
const CORNER_ANGLE_TOL_DEG: f64 = 1.0;
/// The shortest wall on either side of a beaded corner, mm.
const CORNER_WALL_MIN_MM: f64 = 0.6;
/// From this shorter leg (mm) the bead is a little wider for its leg and slants in toward its far end.
const CORNER_WIDE_LEG_MM: f64 = 0.19;
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
