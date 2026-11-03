// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Size compensation of the slices: `xy_contour_compensation` and `xy_hole_compensation` grow or
//! shrink outlines and holes by fixed amounts, and `elefant_foot_compensation` pulls the first
//! layers' outline in so the squashed first layer does not bulge.
//!
//! Orca: `PrintObject::make_perimeters` slice post-processing in PrintObjectSlice.cpp
//! (`_shrink_contour_holes`, the elephant foot block) and ElephantFootCompensation.cpp. Orca varies
//! the foot offset along the outline with a ray fan that measures the local width; here the offset
//! is full where the part is at least the compensated perimeter width thick. On Bambu Lab printers a
//! thinner part comes in only as deep as leaves the outer wall's width plus its spacing, so it keeps room
//! for one outer wall loop with nothing between its sides; elsewhere, and on a part thinner than that, it
//! is left whole.

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
    /// [`Self::min_width`] on the first layer, at the first layer's widths.
    min_width_first: i32,
    /// Bambu Lab printers: a stretch too thin for the whole foot offset takes the part of it that leaves
    /// `min_width` ([`elephant_foot`]), and the first layer reads its own widths.
    partial: bool,
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
        let first = cfg.for_first_layer();
        let min_width_first = units(first.outer_wall_width() + first.spacing_for(first.outer_wall_width()));
        Some(Self {
            contour,
            hole,
            foot: foot.max(0),
            foot_layers,
            min_width,
            min_width_first,
            partial: crate::firmware::bambu_printer(cfg, cfg.gcode_flavor),
        })
    }

    /// Compensates the regions of `layer` (first layer 0). Regions keep their order and priority.
    /// `painted` drops the XY part, as Orca does for objects painted with several colors.
    /// Applies the compensation to the regions of a layer. Returns the outline before the elephant foot
    /// compensation when this layer has one: Orca keeps it as the layer's `lslices`, which the layers next
    /// to it read (bridges and overhangs over the first layer are measured against the uncompensated foot).
    pub(crate) fn apply(&self, regions: &mut [(u8, Shapes)], layer: u32, painted: bool) -> Option<Shapes> {
        let foot = self.foot > 0 && layer < self.foot_layers;
        let all: Vec<&Shapes> = regions.iter().map(|(_, s)| s).collect();
        // Painted and above the foot: each region would be cut to the union of all of them, which it already
        // lies in.
        if all.is_empty() || (painted && !foot) {
            return None;
        }
        // Painted regions meet with specks and pinholes between them, which the foot's insets would widen.
        let merged = if painted {
            perimeters::union_min_area(&all, crate::paint::SPECK)
        } else {
            perimeters::union_all(&all)
        };
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
        if foot {
            uncompensated = Some(comp.clone());
            let layers = i64::from(self.foot_layers);
            let e = i64::from(self.foot) - i64::from(self.foot) / layers * i64::from(layer);
            let min_width = if layer == 0 && self.partial {
                self.min_width_first
            } else {
                self.min_width
            };
            comp = elephant_foot(&comp, i32::try_from(e).unwrap_or(0), min_width, self.partial);
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
/// With `partial` a stretch between `min_width` and that thick comes in only as far as leaves `min_width` (at most two
/// [`FOOT_STEP`]s wider), and a thinner one stays as it is; without it every stretch that is not thick stays as it is.
fn elephant_foot(shapes: &Shapes, e: i32, min_width: i32, partial: bool) -> Shapes {
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
        // A tiny island is left alone: under the full offset's own width and area, or with `partial` under the width
        // the partial foot keeps and that area.
        let least = if partial { min_width } else { need };
        let floor = i128::from(least) * i128::from(least) * 5;
        if w < i64::from(least) || h < i64::from(least) || area < floor {
            out.extend(one);
            continue;
        }
        let band = perimeters::difference(&one, &perimeters::offset(&one, -e));
        let thick = perimeters::offset(&perimeters::offset(&one, -(need / 2)), need / 2);
        let mut zone = if thick.is_empty() {
            Vec::new()
        } else {
            perimeters::intersection(&band, &perimeters::offset(&thick, e))
        };
        let rest = if partial {
            perimeters::difference(&band, &zone)
        } else {
            Vec::new()
        };
        if !rest.is_empty() {
            zone.extend(partial_foot(&one, &rest, e, min_width));
            zone = perimeters::union_all(&[&zone]);
        }
        if zone.is_empty() {
            out.extend(one);
        } else {
            out.extend(perimeters::difference(&one, &zone));
        }
    }
    perimeters::union_all(&[&out])
}

/// The depth step of the partial foot, internal units (0.0025 mm): a thin stretch keeps at most twice this more
/// than `min_width`.
const FOOT_STEP: i32 = 25;

/// The part of `rest` (the foot band of `one` that the full offset leaves) that comes off where `one` is thinner
/// than `min_width` plus two `e`. The depths are a grid of [`FOOT_STEP`]s from the outline; the ring of the band
/// between two grid depths comes off where `one` holds a disc of diameter `min_width` plus twice the deeper one there.
/// Only the part of `one` near `rest` is read, since a disc of that size reaches no further.
///
/// A deeper disc fits in fewer places, so the grid depths are bisected: a point no deeper than the middle depth that
/// the middle disc reaches comes off, one it does not reach is decided above the middle, and a deeper point is decided
/// below it only where the middle disc reaches. A strip of one width takes one disc per halving, and each depth's
/// disc is worked out once for all the parts that meet it.
fn partial_foot(one: &Shapes, rest: &Shapes, e: i32, min_width: i32) -> Shapes {
    let reach = min_width + 3 * e;
    let near = perimeters::intersection(one, &perimeters::offset(rest, reach));
    if near.is_empty() {
        return Vec::new();
    }
    let steps = foot_steps(e);
    let level = |k: i32| foot_level(e, steps, k);
    // Each grid depth's disc reach and inset of `near`, worked out once: the halvings of different parts of the band
    // meet the same depths.
    let slots = usize::try_from(steps).unwrap_or(0) + 1;
    let mut reached: Vec<Option<Shapes>> = vec![None; slots];
    let mut insets: Vec<Option<Shapes>> = vec![None; slots];
    let slot = |k: i32| usize::try_from(k).unwrap_or(0);
    let mut zone: Vec<Shapes> = Vec::new();
    // Parts of the band still to decide, with the grid depths (lo, hi] they lie between.
    let mut open: Vec<(Shapes, i32, i32)> = vec![(rest.clone(), 0, steps)];
    while let Some((area, lo, hi)) = open.pop() {
        if area.is_empty() {
            continue;
        }
        let at = if hi - lo == 1 { hi } else { lo + (hi - lo) / 2 };
        let d = level(at);
        let s = match reached.get_mut(slot(at)) {
            Some(memo) => memo
                .get_or_insert_with(|| foot_reach(&near, min_width, d))
                .clone(),
            None => foot_reach(&near, min_width, d),
        };
        if hi - lo == 1 {
            if !s.is_empty() {
                zone.push(perimeters::intersection(&area, &s));
            }
            continue;
        }
        let inner = match insets.get_mut(slot(at)) {
            Some(memo) => memo.get_or_insert_with(|| perimeters::offset(&near, -d)).clone(),
            None => perimeters::offset(&near, -d),
        };
        let shallow = perimeters::difference(&area, &inner);
        if s.is_empty() {
            open.push((shallow, lo, at));
            continue;
        }
        let deep = perimeters::intersection(&area, &inner);
        zone.push(perimeters::intersection(&shallow, &s));
        open.push((perimeters::difference(&shallow, &s), lo, at));
        open.push((perimeters::intersection(&deep, &s), at, hi));
    }
    let zone: Vec<&Shapes> = zone.iter().filter(|z| !z.is_empty()).collect();
    if zone.is_empty() {
        return Vec::new();
    }
    perimeters::union_all(&zone)
}

/// How many [`FOOT_STEP`]s the foot offset `e` spans.
fn foot_steps(e: i32) -> i32 {
    ((e + FOOT_STEP - 1) / FOOT_STEP).max(1)
}

/// The grid depth `k` of [`partial_foot`], internal units.
fn foot_level(e: i32, steps: i32, k: i32) -> i32 {
    if k == 0 { 0 } else { (e * k / steps).max(1) }
}

/// Where a disc of diameter `min_width` plus two `d` fits in `area`, grown by `d`: the band it lets come off.
fn foot_reach(area: &Shapes, min_width: i32, d: i32) -> Shapes {
    let r = min_width / 2 + d;
    let room = perimeters::offset(&perimeters::offset(area, -r), r);
    if room.is_empty() {
        room
    } else {
        perimeters::offset(&room, d)
    }
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
    use crate::fm::Fm as _;

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
        let compensated = elephant_foot(&block, 2_000, 8_000, true);
        assert_eq!(width(&compensated), 296_000);
        // A 0.6 mm wall is thinner than the perimeter width: left as it is.
        let wall = square(0, 0, 300_000, 6_000);
        assert_eq!(
            perimeters::bounds(&elephant_foot(&wall, 2_000, 8_000, true)),
            perimeters::bounds(&wall)
        );
    }

    /// A short thin strip takes the partial foot too: a 1.1 by 6 mm strip (6.6 mm square, under the 7.9 mm square
    /// floor that leaves a tiny island whole when the full offset is all there is) comes in as far as a long one does.
    #[test]
    fn a_short_thin_strip_takes_the_partial_foot() {
        let height = |s: &Shapes| perimeters::bounds(s).map_or(0, |b| b[3] - b[1]);
        let (e, min_width) = (1_500, 9_571);
        for len in [60_000, 90_000, 309_000] {
            let strip = square(0, 0, len, 11_000);
            let got = height(&elephant_foot(&strip, e, min_width, true));
            assert!(
                (min_width..=min_width + 2 * FOOT_STEP).contains(&got),
                "length {len}: {got}"
            );
        }
    }

    /// Without `partial` a strip too thin for the whole offset keeps its width, and a thick one takes all of it.
    #[test]
    fn without_the_partial_foot_a_thin_strip_keeps_its_width() {
        let height = |s: &Shapes| perimeters::bounds(s).map_or(0, |b| b[3] - b[1]);
        let (e, min_width) = (1_500, 7_971);
        for w in [10_110, 10_940] {
            let strip = square(0, 0, 309_000, w);
            assert_eq!(height(&elephant_foot(&strip, e, min_width, false)), w, "W {w}");
        }
        let strip = square(0, 0, 309_000, 15_000);
        assert_eq!(height(&elephant_foot(&strip, e, min_width, false)), 12_000);
    }

    /// [`partial_foot`] taken one grid depth at a time: each ring of the band comes off where the disc of its deeper
    /// depth reaches.
    fn partial_foot_stepped(one: &Shapes, rest: &Shapes, e: i32, min_width: i32) -> Shapes {
        let steps = foot_steps(e);
        let mut zone: Shapes = Vec::new();
        for k in 1..=steps {
            let d = foot_level(e, steps, k);
            let s = foot_reach(one, min_width, d);
            if s.is_empty() {
                break;
            }
            let ring = perimeters::difference(
                &perimeters::offset(one, -foot_level(e, steps, k - 1)),
                &perimeters::offset(one, -d),
            );
            zone.extend(perimeters::intersection(
                &perimeters::intersection(&ring, rest),
                &s,
            ));
        }
        perimeters::union_all(&[&zone])
    }

    #[allow(clippy::cast_precision_loss, reason = "test areas fit f64")]
    fn area_of(s: &Shapes) -> f64 {
        s.iter()
            .flat_map(|x| x.iter())
            .map(|r| crate::geom::area2_int(r) as f64)
            .sum::<f64>()
            / 2.0
    }

    /// The bisected partial foot takes off what the stepped one does, to within one step along the outline: strips
    /// of a sweep of widths, a wedge that widens from too thin to thick enough for the whole offset, and a ring whose
    /// wall thins to one side.
    #[test]
    fn the_bisected_partial_foot_matches_the_stepped_one() {
        let (e, min_width) = (1_500, 9_571);
        let mut shapes: Vec<Shapes> = (0..40).map(|i| square(0, 0, 120_000, 9_000 + i * 100)).collect();
        shapes.push(vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(200_000, 0),
            IntPoint::new(200_000, 14_000),
            IntPoint::new(0, 8_500),
        ]]]);
        #[allow(clippy::cast_possible_truncation, reason = "test points")]
        let circle = |cx: f64, r: f64, hole: bool| {
            let mut ring: Vec<IntPoint<i32>> = (0..720)
                .map(|i| {
                    let a = f64::from(i) * std::f64::consts::PI / 360.0;
                    IntPoint::new((cx + r * a.m_cos()) as i32, (r * a.m_sin()) as i32)
                })
                .collect();
            if hole {
                ring.reverse();
            }
            ring
        };
        shapes.push(vec![vec![
            circle(0.0, 100_000.0, false),
            circle(-2_000.0, 91_000.0, true),
        ]]);
        let need = min_width + 2 * e;
        let mut taken = 0;
        for (i, one) in shapes.iter().enumerate() {
            let band = perimeters::difference(one, &perimeters::offset(one, -e));
            let thick = perimeters::offset(&perimeters::offset(one, -(need / 2)), need / 2);
            let full = if thick.is_empty() {
                Vec::new()
            } else {
                perimeters::intersection(&band, &perimeters::offset(&thick, e))
            };
            let rest = perimeters::difference(&band, &full);
            let bisected = partial_foot(one, &rest, e, min_width);
            let stepped = partial_foot_stepped(one, &rest, e, min_width);
            taken += usize::from(!stepped.is_empty());
            let apart = area_of(&perimeters::difference(&bisected, &stepped))
                + area_of(&perimeters::difference(&stepped, &bisected));
            let outline: f64 = one
                .iter()
                .flat_map(|s| s.iter())
                .map(|r| {
                    r.iter()
                        .zip(r.iter().cycle().skip(1))
                        .map(|(a, b)| f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y)))
                        .sum::<f64>()
                })
                .sum();
            assert!(
                apart <= outline * f64::from(FOOT_STEP),
                "shape {i}: {apart} apart, outline {outline}"
            );
        }
        assert!(taken >= 30, "{taken} shapes take part of the foot");
    }

    /// A strip between the outer wall's width plus its spacing (`min_width`) and that plus two foot offsets comes in
    /// only as far as leaves `min_width`, give or take a step; a wider one takes the whole offset, a narrower one none.
    #[test]
    fn a_thin_strip_takes_only_the_part_of_the_foot_that_leaves_room_for_the_outer_wall() {
        let height = |s: &Shapes| perimeters::bounds(s).map_or(0, |b| b[3] - b[1]);
        let (e, min_width) = (1_500, 9_571);
        for w in [10_110, 10_550, 10_940, 11_090, 12_500] {
            let strip = square(0, 0, 309_000, w);
            let got = height(&elephant_foot(&strip, e, min_width, true));
            assert!(
                (min_width..=min_width + 2 * FOOT_STEP).contains(&got),
                "W {w}: {got}"
            );
        }
        for w in [12_571, 15_000, 24_440] {
            let strip = square(0, 0, 309_000, w);
            assert_eq!(
                height(&elephant_foot(&strip, e, min_width, true)),
                w - 2 * e,
                "W {w}"
            );
        }
        let strip = square(0, 0, 309_000, 9_000);
        assert_eq!(height(&elephant_foot(&strip, e, min_width, true)), 9_000);
    }
}
