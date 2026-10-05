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
    // Strips between 0.2 spacings (less the squish tolerance) and 2 spacings wide.
    let min = 0.2 * spacing_mm * (1.0 - 0.4);
    let max = 2.0 * spacing_mm;
    let opened = perimeters::offset(&perimeters::offset(&open, -mm(min / 2.0)), mm(min / 2.0));
    let wide = perimeters::offset(&perimeters::offset(&open, -mm(max / 2.0)), mm(max / 2.0) + 10);
    let strips = perimeters::difference(&opened, &wide);
    let filter = crate::motion::raw_f(cfg, "filter_out_gap_fill").unwrap_or(0.0);
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
        for line in crate::arachne::medial_lines(&simple, min, max) {
            let len: f64 = line
                .points
                .windows(2)
                .map(|w| match w {
                    [a, b] => f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y)) / crate::geom::SCALE,
                    _ => 0.0,
                })
                .sum();
            if len >= filter {
                out.push(line);
            }
        }
    }
    out
}

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
