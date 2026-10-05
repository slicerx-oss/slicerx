// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Wave overhangs (`wave_overhangs`): an unsupported overhang is printed as rings that grow from the
//! supported edge, each bead resting on the one before it, instead of as bridge strands over air.
//!
//! This is the technique of Steven `McCulloch`'s arc overhangs, in the form of the Wave Overhangs of
//! Andersons, Sanchez and Vaneker as `OrcaSlicer` forks carry it (`dennisklappe/OrcaSlicer-WaveOverhangs`):
//! a seed is the supported material beside the overhang, and each round the covered area grows by one
//! line spacing inside the overhang and the new front is printed, slowly, with the fan on, until the
//! overhang is filled. The setting names follow that fork. The implementation is our own: the fork's
//! source and the paper are not among the files we read.

use crate::config::PrintConfig;
use crate::geom::{Point, mm};
use crate::overhang::{Support, split_polyline};
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// Wave overhang settings.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Params {
    pub spacing: f64,
    pub flow_mm3: f64,
    pub speed: f32,
    pub overlap: f64,
    pub min_length: f64,
    pub min_new_area: f64,
    pub max_iterations: u32,
}

impl Params {
    pub(crate) fn of(cfg: &PrintConfig) -> Option<Self> {
        if !crate::firmware::truthy(cfg, "wave_overhangs") {
            return None;
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "small settings"
        )]
        Some(Self {
            spacing: cfg.raw_number("wave_overhang_line_spacing", 0.35).max(0.05),
            flow_mm3: cfg
                .raw_number("wave_overhang_flow_mm3_per_mm", 0.16)
                .clamp(0.02, 1.5),
            speed: cfg.raw_number("wave_overhang_print_speed", 2.0).max(0.1) as f32,
            overlap: cfg.raw_number("wave_overhang_perimeter_overlap", 0.1).max(0.0),
            min_length: cfg.raw_number("wave_overhang_min_length", 0.0).max(0.0),
            min_new_area: cfg.raw_number("wave_overhang_min_new_area", 0.01).max(0.0),
            max_iterations: cfg.raw_number("wave_overhang_max_iterations", 0.0).max(0.0) as u32,
        })
    }
}

fn area_mm2(shapes: &Shapes) -> f64 {
    shapes
        .iter()
        .map(|s| {
            s.iter()
                .enumerate()
                .map(|(i, r)| {
                    #[allow(clippy::cast_precision_loss, reason = "areas of a few mm2")]
                    let a = crate::geom::area2_int(r).abs() as f64
                        / 2.0
                        / crate::geom::SCALE
                        / crate::geom::SCALE;
                    if i == 0 { a } else { -a }
                })
                .sum::<f64>()
        })
        .sum()
}

/// The rings that fill `overhang`, from `supported` (material the overhang rests on at this layer's
/// edge) outward: polylines in print order, each a front of the growing covered area.
pub(crate) fn rings(overhang: &Shapes, supported: &Shapes, p: &Params) -> Vec<Vec<Point>> {
    let step = mm(p.spacing);
    let mut covered = perimeters::offset_round(supported, mm(p.overlap));
    let mut out: Vec<Vec<Point>> = Vec::new();
    // Slightly smaller, so a ring that runs along the overhang's edge crosses it properly.
    let region = Support::new(&perimeters::offset(overhang, -mm(0.02)));
    let mut round = 0u32;
    loop {
        if p.max_iterations > 0 && round >= p.max_iterations {
            break;
        }
        // The next front is the covered area grown half a spacing: its edge inside the overhang is the
        // center line of the new bead. The covered area then grows a whole spacing.
        let half = perimeters::offset_round(&covered, step / 2);
        let grown = perimeters::offset_round(&covered, step);
        let allowed = perimeters::union_all(&[&covered, overhang]);
        let next = perimeters::intersection(&grown, &allowed);
        let new_area = area_mm2(&perimeters::difference(&next, &covered));
        if new_area <= p.min_new_area || round > 2000 {
            break;
        }
        let mut lines: Vec<Vec<Point>> = Vec::new();
        for ring in half.iter().flat_map(|s| s.iter()) {
            if ring.len() < 3 {
                continue;
            }
            let mut closed: Vec<IntPoint<i32>> = ring.clone();
            if let Some(&f) = closed.first() {
                closed.push(f);
            }
            for (piece, outside) in split_polyline(&closed, &region) {
                // `outside` is relative to the overhang region: inside pieces are the fronts.
                if !outside && piece.len() >= 2 {
                    let len: f64 = piece
                        .windows(2)
                        .map(|w| match w {
                            [a, b] => Point::new(a.x, a.y).dist_mm(Point::new(b.x, b.y)),
                            _ => 0.0,
                        })
                        .sum();
                    if len >= p.min_length.max(p.spacing) {
                        lines.push(piece.iter().map(|q| Point::new(q.x, q.y)).collect());
                    }
                }
            }
        }
        // Every other ring runs the other way, so the nozzle ends each one near where the next starts.
        if round % 2 == 1 {
            for l in &mut lines {
                l.reverse();
            }
        }
        out.extend(lines);
        covered = next;
        round += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let p = |x: f64, y: f64| IntPoint::new(mm(x), mm(y));
        vec![vec![vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]]]
    }

    #[test]
    fn rings_fill_an_overhang_from_the_supported_edge_outward() {
        // A 10 x 6 mm overhang beside a supported block on its left.
        let overhang = rect(0.0, 0.0, 10.0, 6.0);
        let supported = rect(-5.0, -2.0, 0.0, 8.0);
        let p = Params {
            spacing: 0.4,
            flow_mm3: 0.16,
            speed: 2.0,
            overlap: 0.1,
            min_length: 0.0,
            min_new_area: 0.01,
            max_iterations: 0,
        };
        let r = rings(&overhang, &supported, &p);
        // About 10 mm / 0.4 mm rings, each a front running across the overhang's width.
        assert!((20..=30).contains(&r.len()), "{}", r.len());
        #[allow(clippy::cast_precision_loss, reason = "a point count")]
        let xs: Vec<f64> = r
            .iter()
            .map(|l| l.iter().map(|q| q.x_mm()).sum::<f64>() / l.len() as f64)
            .collect();
        assert!(
            xs.windows(2).all(|w| w[1] >= w[0] - 0.05),
            "rings move away from the support: {xs:?}"
        );
        // Together they cover about the overhang: total length x spacing is its area, within 25 percent.
        let len: f64 = r
            .iter()
            .flat_map(|l| l.windows(2))
            .map(|w| w[0].dist_mm(w[1]))
            .sum();
        assert!((len * 0.4 - 60.0).abs() < 15.0, "{}", len * 0.4);
    }
}
