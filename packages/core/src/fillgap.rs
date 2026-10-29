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
    use i_overlay::i_float::int::point::IntPoint;

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
