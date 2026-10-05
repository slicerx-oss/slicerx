// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Size compensation of the slices: `xy_contour_compensation` and `xy_hole_compensation` grow or
//! shrink outlines and holes by fixed amounts, and `elefant_foot_compensation` pulls the first
//! layers' outline in so the squashed first layer does not bulge.
//!
//! Orca: `PrintObject::make_perimeters` slice post-processing in PrintObjectSlice.cpp
//! (`_shrink_contour_holes`, the elephant foot block) and ElephantFootCompensation.cpp. Orca varies
//! the foot offset along the outline with a ray fan that measures the local width; here the offset
//! is full where the part is at least the compensated perimeter width thick and absent where it is
//! thinner, which gives the same outline on bodies and keeps thin walls whole.

use crate::config::PrintConfig;
use crate::geom::SCALE;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// The compensation settings of a print, in internal units.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Comp {
    contour: i32,
    hole: i32,
    foot: i32,
    foot_layers: u32,
    /// Width the external perimeter needs: its width plus its spacing.
    min_width: i32,
}

fn units(mm: f64) -> i32 {
    #[allow(clippy::cast_possible_truncation, reason = "distances are a few millimeters")]
    {
        (mm * SCALE).round() as i32
    }
}

impl Comp {
    /// `None` when nothing needs compensating.
    pub(crate) fn new(cfg: &PrintConfig) -> Option<Self> {
        let contour = units(cfg.raw_number("xy_contour_compensation", 0.0));
        let hole = units(cfg.raw_number("xy_hole_compensation", 0.0));
        // The foot is only compensated on the bed, not on a raft.
        let foot = if cfg.raw_number("raft_layers", 0.0) > 0.0 {
            0
        } else {
            units(cfg.raw_number("elefant_foot_compensation", 0.0))
        };
        if contour == 0 && hole == 0 && foot <= 0 {
            return None;
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small layer count"
        )]
        let foot_layers = cfg.raw_number("elefant_foot_compensation_layers", 1.0).max(1.0) as u32;
        let min_width = units(cfg.outer_wall_width() + cfg.spacing_for(cfg.outer_wall_width()));
        Some(Self {
            contour,
            hole,
            foot: foot.max(0),
            foot_layers,
            min_width,
        })
    }

    /// Compensates the regions of `layer` (first layer 0). Regions keep their order and priority.
    /// `painted` drops the XY part, as Orca does for objects painted with several colors.
    /// Applies the compensation to the regions of a layer. Returns the outline before the elephant foot
    /// compensation when this layer has one: Orca keeps it as the layer's `lslices`, which the layers next
    /// to it read (bridges and overhangs over the first layer are measured against the uncompensated foot).
    pub(crate) fn apply(&self, regions: &mut [(u8, Shapes)], layer: u32, painted: bool) -> Option<Shapes> {
        let all: Vec<&Shapes> = regions.iter().map(|(_, s)| s).collect();
        if all.is_empty() {
            return None;
        }
        let merged = perimeters::union_all(&all);
        let (contour, hole) = if painted {
            (0, 0)
        } else {
            (self.contour, self.hole)
        };
        let mut comp = merged.clone();
        if contour > 0 || hole > 0 {
            comp = shrink_contour_holes(contour.max(0), hole.max(0), &comp);
        }
        if contour < 0 || hole < 0 {
            comp = shrink_contour_holes(contour.min(0), hole.min(0), &comp);
        }
        let mut uncompensated = None;
        if self.foot > 0 && layer < self.foot_layers {
            uncompensated = Some(comp.clone());
            let layers = i64::from(self.foot_layers);
            let e = i64::from(self.foot) - i64::from(self.foot) / layers * i64::from(layer);
            comp = elephant_foot(&comp, i32::try_from(e).unwrap_or(0), self.min_width);
        }
        let growth = contour.max(hole);
        let mut processed: Shapes = Vec::new();
        let count = regions.len();
        for (i, (_, shapes)) in regions.iter_mut().enumerate() {
            let source = if growth > 0 {
                perimeters::offset(shapes, growth)
            } else {
                shapes.clone()
            };
            let mut s = perimeters::intersection(&source, &comp);
            if growth > 0 && !processed.is_empty() {
                s = perimeters::difference(&s, &processed);
            }
            if growth > 0 && i + 1 < count {
                processed = perimeters::union_all(&[&processed, &s]);
            }
            *shapes = s;
        }
        uncompensated
    }
}

/// A ring as a region of its own, in the orientation outlines have.
fn as_region(ring: &[IntPoint<i32>], want_positive: bool) -> Shapes {
    let mut r = ring.to_vec();
    if (crate::geom::area2_int(&r) > 0) != want_positive {
        r.reverse();
    }
    vec![vec![r]]
}

/// Outlines grown by `contour` and holes by `hole` (negative shrinks); Orca's `_shrink_contour_holes`.
pub(crate) fn shrink_contour_holes(contour: i32, hole: i32, shapes: &Shapes) -> Shapes {
    let mut out: Shapes = Vec::new();
    for shape in shapes {
        let Some(outer) = shape.first() else { continue };
        let mut contours = as_region(outer, true);
        if contour != 0 {
            contours = perimeters::offset(&contours, contour);
            if contours.is_empty() {
                continue;
            }
        }
        let mut holes: Shapes = Vec::new();
        for h in shape.iter().skip(1) {
            let region = as_region(h, true);
            let grown = if hole == 0 {
                region
            } else {
                perimeters::offset(&region, hole)
            };
            holes.extend(grown);
        }
        let holes = perimeters::union_all(&[&holes]);
        out.extend(perimeters::difference(&contours, &holes));
    }
    perimeters::union_all(&[&out])
}

/// The outline of each island pulled in by `e` along the stretches where the part is thick enough
/// to take it: a stretch is thick when the compensated perimeter width (`min_width` plus two `e`) fits.
fn elephant_foot(shapes: &Shapes, e: i32, min_width: i32) -> Shapes {
    if e <= 0 {
        return shapes.clone();
    }
    let need = min_width + 2 * e;
    let mut out: Shapes = Vec::new();
    for shape in shapes {
        let one: Shapes = vec![shape.clone()];
        let Some(b) = perimeters::bounds(&one) else {
            continue;
        };
        let (w, h) = (
            i64::from(b[2]) - i64::from(b[0]),
            i64::from(b[3]) - i64::from(b[1]),
        );
        let area = one
            .iter()
            .flat_map(|s| s.iter())
            .map(|r| i128::from(crate::geom::area2_int(r)))
            .sum::<i128>()
            / 2;
        // A tiny island is left alone.
        if w < i64::from(need) || h < i64::from(need) || area < i128::from(need) * i128::from(need) * 5 {
            out.extend(one);
            continue;
        }
        let thick = perimeters::offset(&perimeters::offset(&one, -(need / 2)), need / 2);
        if thick.is_empty() {
            out.extend(one);
            continue;
        }
        let band = perimeters::difference(&one, &perimeters::offset(&one, -e));
        let zone = perimeters::intersection(&band, &perimeters::offset(&thick, e));
        out.extend(perimeters::difference(&one, &zone));
    }
    perimeters::union_all(&[&out])
}

/// A filament setting in percent for a slot (`"98.5%"` or a number), 100 when absent.
fn percent_for(cfg: &PrintConfig, key: &str, slot: u8) -> f64 {
    let at = |v: &serde_json::Value| match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().trim_end_matches('%').trim().parse().ok(),
        _ => None,
    };
    match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a
            .get(usize::from(slot.max(1) - 1))
            .or_else(|| a.last())
            .and_then(at)
            .unwrap_or(100.0),
        Some(v) => at(v).unwrap_or(100.0),
        None => 100.0,
    }
}

/// The XY and Z scale that undoes the filament's shrinkage on cooling (`filament_shrink`,
/// `filament_shrinkage_compensation_z`): 100 over the percentage. Orca (`Print::shrinkage_compensation`)
/// applies it only when every filament the plate uses shrinks alike.
pub(crate) fn shrinkage(plate: &crate::plate::Plate, cfg: &PrintConfig) -> Option<[f64; 3]> {
    let mut slots: Vec<u8> = Vec::new();
    for obj in &plate.objects {
        for part in &obj.mesh.parts {
            slots.push(obj.slot_for(&part.name, part.slot));
            slots.extend(part.paint.iter().map(|f| f.state.max(1)));
        }
    }
    slots.sort_unstable();
    slots.dedup();
    let first = *slots.first()?;
    let values = |s: u8| {
        (
            percent_for(cfg, "filament_shrink", s),
            percent_for(cfg, "filament_shrinkage_compensation_z", s),
        )
    };
    let (xy, z) = values(first);
    if slots.iter().any(|&s| values(s) != (xy, z)) {
        return None;
    }
    if (xy - 100.0).abs() < 1e-9 && (z - 100.0).abs() < 1e-9 {
        return None;
    }
    Some([100.0 / xy.max(1.0), 100.0 / xy.max(1.0), 100.0 / z.max(1.0)])
}

/// The plate with each object scaled by `f` about the center of its footprint, Z from the bed.
pub(crate) fn scale_plate(plate: &crate::plate::Plate, f: [f64; 3]) -> crate::plate::Plate {
    let mut out = plate.clone();
    for obj in &mut out.objects {
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in obj.mesh.parts.iter().flat_map(|p| p.positions.iter()) {
            let w = obj.apply(*p);
            for ((l, h), v) in lo.iter_mut().zip(hi.iter_mut()).zip(w) {
                *l = l.min(v);
                *h = h.max(v);
            }
        }
        if lo[0] > hi[0] {
            continue;
        }
        let c = [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1]), 0.0];
        let m = obj.transform.map(f64::from);
        // Column-major: element `i` is row `i % 4`, column `i / 4`. Rows 0 to 2 scale by `f`; the
        // translation column picks up the center: x' = s (x - c) + c.
        let n: [f64; 16] = std::array::from_fn(|i| {
            let (row, col) = (i % 4, i / 4);
            match (f.get(row), c.get(row), m.get(i)) {
                (Some(&scale), Some(&center), Some(&v)) if col == 3 => scale * (v - center) + center,
                (Some(&scale), _, Some(&v)) => v * scale,
                (_, _, Some(&v)) => v,
                _ => 0.0,
            }
        });
        #[allow(clippy::cast_possible_truncation, reason = "the transform is f32")]
        {
            obj.transform = n.map(|v| v as f32);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x0: i32, y0: i32, x1: i32, y1: i32) -> Shapes {
        vec![vec![vec![
            IntPoint::new(x0, y0),
            IntPoint::new(x1, y0),
            IntPoint::new(x1, y1),
            IntPoint::new(x0, y1),
        ]]]
    }

    fn width(s: &Shapes) -> i32 {
        perimeters::bounds(s).map_or(0, |b| b[2] - b[0])
    }

    #[test]
    fn contours_grow_and_holes_grow_apart() {
        let plate = square(0, 0, 200_000, 200_000);
        assert_eq!(width(&shrink_contour_holes(1_000, 0, &plate)), 202_000);
        assert_eq!(width(&shrink_contour_holes(-1_000, 0, &plate)), 198_000);
        // A square with a hole: a positive hole value makes the hole bigger, so the material smaller.
        let mut with_hole = square(0, 0, 200_000, 200_000);
        let hole = square(80_000, 80_000, 120_000, 120_000);
        let mut ring = hole[0][0].clone();
        ring.reverse();
        with_hole[0].push(ring);
        let area = |s: &Shapes| -> i64 {
            s.iter()
                .flat_map(|x| x.iter())
                .map(|r| crate::geom::area2_int(r))
                .sum()
        };
        let bigger = shrink_contour_holes(0, 1_000, &with_hole);
        assert!(
            area(&bigger) < area(&with_hole),
            "{} vs {}",
            area(&bigger),
            area(&with_hole)
        );
        let smaller = shrink_contour_holes(0, -1_000, &with_hole);
        assert!(area(&smaller) > area(&with_hole));
    }

    #[test]
    fn the_elephant_foot_comes_in_on_a_thick_part_and_leaves_a_thin_wall_alone() {
        let block = square(0, 0, 300_000, 300_000);
        let compensated = elephant_foot(&block, 2_000, 8_000);
        assert_eq!(width(&compensated), 296_000);
        // A 0.6 mm wall is thinner than the perimeter width: left as it is.
        let wall = square(0, 0, 300_000, 6_000);
        assert_eq!(
            perimeters::bounds(&elephant_foot(&wall, 2_000, 8_000)),
            perimeters::bounds(&wall)
        );
    }
}
