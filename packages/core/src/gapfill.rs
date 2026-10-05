// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Gap fill: the thin strips the wall loops leave between them or inside a
//! narrow part, where the walls stop because the next loop would not fit.
//! Each strip gets one bead down its middle, as wide as the strip.
//!
//! The strips are the parts of each wall's inner side that the next wall (or
//! the infill) does not cover. Their middle line is found by shrinking the
//! strip in small steps until it is about to vanish; what is left is a sliver
//! along the middle.

use crate::fm::Fm as _;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

type Pt = IntPoint<i32>;

/// A gap bead: the path and its width in internal units.
pub(crate) type Gap = (Vec<Pt>, i32);

/// Strips of `island` (one shape) that `wall_loops` walls of width `w` leave open.
#[allow(
    clippy::cast_possible_truncation,
    reason = "offsets are a fraction of a line width"
)]
pub(crate) fn find(island: &Shapes, wall_loops: u32, w: i32) -> Vec<Gap> {
    let mut raw: Shapes = Vec::new();
    for i in 0..wall_loops {
        #[allow(clippy::cast_possible_wrap, reason = "wall counts are capped at 50")]
        let k = i as i32;
        // What wall i leaves inside it, minus what the next wall (or the infill) covers.
        let inside = perimeters::offset(island, -(w * (k + 1)));
        if inside.is_empty() {
            break;
        }
        let next = perimeters::offset(&perimeters::offset(island, -(w * (2 * k + 3)) / 2), w / 2);
        let gap = perimeters::difference(&inside, &next);
        raw.extend(gap);
    }
    if raw.is_empty() {
        return Vec::new();
    }
    let gaps = perimeters::union_all(&[&raw]);
    // Strips under a fifth of a line width cannot be printed and are slivers of the offsets.
    let sliver = w / 10;
    let gaps = perimeters::offset(&perimeters::offset(&gaps, -sliver), sliver);
    let mut out = Vec::new();
    for shape in &gaps {
        let one: Shapes = vec![shape.clone()];
        let area = shape_area(&one);
        if let Some(path) = middle(&one, w) {
            let len = path_len(&path);
            if len >= f64::from(w) && area > 0.0 {
                out.push((path, ((area / len).round() as i32).clamp(w / 5, w * 6 / 5)));
            }
        }
    }
    out
}

/// Orca's gap regions for classic walls (`PerimeterGenerator::process_classic`): after each loop the
/// part of the previous loop's interior that the next loop cannot reach (narrower than a loop pitch
/// plus a squish tolerance) is a gap, collected until a loop fails to appear. `ext_w` and `inner_w`
/// are the wall widths, `spacing` the inner loop pitch and `spacing2` the pitch between the outer and
/// the first inner wall. The gaps keep what is between `min` and `max` wide, and each gets one bead.
/// `chain` holds the loop areas the walls already worked out (the outer wall's first), the same ones
/// this walk reaches, so they are not offset again.
#[allow(
    clippy::cast_possible_truncation,
    clippy::too_many_arguments,
    reason = "offsets are a fraction of a line width"
)]
pub(crate) fn find_orca(
    island: &Shapes,
    chain: &[Shapes],
    loops: u32,
    ext_w: i32,
    inner_w: i32,
    spacing: i32,
    spacing2: i32,
    layer_height: f64,
) -> (Vec<crate::arachne::WallLine>, Shapes) {
    if no_gaps(chain, loops, spacing, spacing2, narrowest(ext_w, inner_w)) {
        return (Vec::new(), Vec::new());
    }
    orca_gaps(
        island,
        chain,
        loops,
        ext_w,
        inner_w,
        spacing,
        spacing2,
        layer_height,
    )
}

/// The narrowest gap that gets a bead, internal units (Orca: a fifth of the narrower width less the squish
/// tolerance).
#[allow(clippy::cast_possible_truncation, reason = "a fraction of a line width")]
fn narrowest(ext_w: i32, inner_w: i32) -> i32 {
    (f64::from(ext_w.min(inner_w)) * 0.2 * 0.6) as i32
}

/// True when [`orca_gaps`] is certain to find nothing: every loop of `chain` is a plain offset of the one before
/// it ([`perimeters::plain_offsets`]), so the part of each loop's inner side the next loop does not reach is
/// empty, save for the slivers rounding leaves, and those are far thinner than the narrowest gap and vanish in its
/// opening.
///
/// For each loop the walk offsets the loop before it in by half a pitch (`a`), and in by a pitch and the squish
/// margin and out by the margin (the next loop); the gap is what the next loop grown by half a pitch and ten units
/// (`b`) leaves of `a`. With plain offsets `a` lies 10 units inside `b`. Rounding moves a loop by at most a unit or
/// two; offsetting that loop again tilts its edges by at most twice that over their length, moving the offset edge
/// by the offset distance times the tilt, and a corner by the miter factor times its edges' move. The gaps are then
/// at most as wide as those errors, which must stay under a quarter of the narrowest gap.
fn no_gaps(chain: &[Shapes], loops: u32, spacing: i32, spacing2: i32, min: i32) -> bool {
    let min_spacing = spacing * 6 / 10;
    let margin = min_spacing / 2 - 1;
    if loops == 0 || chain.len() < loops as usize {
        return false;
    }
    (1..=loops).all(|i| {
        let Some(last) = chain.get(i as usize - 1).filter(|l| !l.is_empty()) else {
            return false;
        };
        let d = if i == 1 { spacing2 } else { spacing };
        let reach = d / 2 + 10;
        let dists = [
            f64::from(d - reach),
            f64::from(d / 2),
            f64::from(d),
            f64::from(d + margin),
        ];
        let fits = |shortest: f64, miter: f64| {
            let round = 2.0;
            let next = miter * (round + 2.0 * f64::from(margin) * round / shortest) + round;
            let grown = miter * (next + 2.0 * f64::from(reach) * next / shortest) + round;
            grown + round <= f64::from(min) / 4.0
        };
        // The shortest edge that can fit at all, with no corner turning: the errors fall as edges grow.
        let (mut lo, mut hi) = (1.0f64, 1e7f64);
        for _ in 0..40 {
            let mid = (lo * hi).sqrt();
            if fits(mid, 1.0) {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        perimeters::plain_offsets(last, &dists, lo, fits)
    })
}

/// Orca's walk over the loops, as [`find_orca`] describes it.
#[allow(
    clippy::cast_possible_truncation,
    clippy::too_many_arguments,
    reason = "offsets are a fraction of a line width"
)]
fn orca_gaps(
    island: &Shapes,
    chain: &[Shapes],
    loops: u32,
    ext_w: i32,
    inner_w: i32,
    spacing: i32,
    spacing2: i32,
    layer_height: f64,
) -> (Vec<crate::arachne::WallLine>, Shapes) {
    // Loops may squish into each other by this much (Orca: INSET_OVERLAP_TOLERANCE, 0.4).
    let min_spacing = spacing * 6 / 10;
    let mut last = chain
        .first()
        .cloned()
        .unwrap_or_else(|| perimeters::offset(island, -(ext_w / 2)));
    let mut gaps: Shapes = Vec::new();
    for i in 1..=loops {
        if last.is_empty() {
            break;
        }
        let d = if i == 1 { spacing2 } else { spacing };
        let offsets = chain.get(i as usize).cloned().unwrap_or_else(|| {
            perimeters::offset(
                &perimeters::offset(&last, -(d + min_spacing / 2 - 1)),
                min_spacing / 2 - 1,
            )
        });
        let reach = perimeters::offset(&offsets, d / 2 + 10);
        gaps.extend(perimeters::difference(
            &perimeters::offset(&last, -(d / 2)),
            &reach,
        ));
        if offsets.is_empty() {
            break;
        }
        last = offsets;
    }
    if gaps.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let gaps = perimeters::union_all(&[&gaps]);
    let min = narrowest(ext_w, inner_w);
    let max = 2 * spacing;
    let open = |s: &Shapes, r: i32| perimeters::offset(&perimeters::offset(s, -r), r);
    let thin = perimeters::difference(
        &open(&gaps, min / 2),
        &perimeters::offset(&perimeters::offset(&gaps, -(max / 2)), max / 2 + 10),
    );
    // One bead down the middle of each strip, as wide as the strip (Orca: the medial axis between `min` and `max`).
    let scale = crate::geom::SCALE;
    let _ = layer_height;
    let mut out = Vec::new();
    // The strips that got a bead; the infill keeps clear of them (Orca subtracts the beads' footprint).
    let mut covered: Shapes = Vec::new();
    for shape in &thin {
        let one: Shapes = vec![shape.clone()];
        let l = crate::arachne::medial_lines(&one, f64::from(min) / scale, f64::from(max) / scale);
        if !l.is_empty() {
            covered.push(shape.clone());
        }
        out.extend(l);
    }
    (out, covered)
}

#[allow(clippy::cast_precision_loss, reason = "areas of one layer fit f64")]
fn shape_area(s: &Shapes) -> f64 {
    let sum: i64 = s
        .iter()
        .flat_map(|sh| sh.iter())
        .map(|r| crate::geom::area2_int(r))
        .sum();
    sum as f64 / 2.0
}

fn path_len(p: &[Pt]) -> f64 {
    p.windows(2)
        .map(|w| match w {
            [a, b] => f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y)),
            _ => 0.0,
        })
        .sum()
}

/// The middle of a strip: shrink it step by step and keep the last thing left.
fn middle(strip: &Shapes, w: i32) -> Option<Vec<Pt>> {
    let step = (w / 20).max(100);
    let mut last = strip.clone();
    for _ in 0..80 {
        let next = perimeters::offset(&last, -step);
        if next.is_empty() {
            break;
        }
        last = next;
    }
    let shape = last.first()?;
    if shape.len() > 1 {
        // A ring of strip (it has a hole): the outer contour, closed.
        let mut ring = shape.first()?.clone();
        ring.push(*ring.first()?);
        return Some(ring);
    }
    let ring = shape.first()?;
    // A sliver: one side of it, between its two ends.
    let far = |from: usize| {
        let p = ring.get(from)?;
        (0..ring.len()).max_by_key(|&i| {
            ring.get(i).map_or(0, |q| {
                let (dx, dy) = (i64::from(q.x - p.x), i64::from(q.y - p.y));
                dx * dx + dy * dy
            })
        })
    };
    let i = far(0)?;
    let j = far(i)?;
    let n = ring.len();
    let mut path = Vec::new();
    let mut k = i;
    while k != j {
        path.push(*ring.get(k)?);
        k = (k + 1) % n;
    }
    path.push(*ring.get(j)?);
    (path.len() >= 2).then_some(path)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "test shapes in plate units"
)]
mod tests {
    use super::*;

    /// A small deterministic generator of numbers in 0..1.
    struct Rng(u64);

    impl Rng {
        fn unit(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            f64::from(u32::try_from(self.0 >> 40).unwrap_or(0)) / f64::from(1u32 << 24)
        }

        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.unit()
        }
    }

    /// A ring around `(cx, cy)` mm with `n` corners at radii from `r * (1 - dent)` to `r`, counterclockwise.
    fn ring(rng: &mut Rng, cx: f64, cy: f64, r: f64, n: u32, dent: f64) -> Vec<Pt> {
        let turn = rng.range(0.0, 6.3);
        (0..n)
            .map(|k| {
                let a = turn + 2.0 * std::f64::consts::PI * f64::from(k) / f64::from(n);
                let rr = r * (1.0 - dent * rng.unit());
                IntPoint::new(
                    ((cx + rr * a.m_cos()) * 1e4).round() as i32,
                    ((cy + rr * a.m_sin()) * 1e4).round() as i32,
                )
            })
            .collect()
    }

    /// Plates and parts as walls see them: an outline (a rectangle, a regular polygon or a dented one) with holes
    /// of every size and corner count, some close to each other or to the outline, cleaned up by a union.
    fn island(rng: &mut Rng) -> Shapes {
        let (w, h) = (rng.range(3.0, 60.0), rng.range(3.0, 60.0));
        let outer: Vec<Pt> = if rng.unit() < 0.5 {
            [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]
                .iter()
                .map(|&(x, y)| IntPoint::new((x * 1e4) as i32, (y * 1e4) as i32))
                .collect()
        } else {
            let n = 3 + (rng.unit() * 60.0) as u32;
            let dent = if rng.unit() < 0.5 {
                0.0
            } else {
                rng.range(0.0, 0.3)
            };
            ring(rng, w / 2.0, h / 2.0, w.min(h) / 2.0, n, dent)
        };
        let mut holes: Vec<(f64, f64, f64)> = Vec::new();
        let mut rings = vec![outer];
        for _ in 0..(rng.unit() * 14.0) as u32 {
            let r = rng.range(0.2, 6.0);
            let (cx, cy) = (rng.range(0.0, w), rng.range(0.0, h));
            // Holes keep clear of each other and of the box, by a margin that is sometimes thinner than a wall.
            let gap = if rng.unit() < 0.3 {
                rng.range(0.05, 0.6)
            } else {
                rng.range(0.6, 5.0)
            };
            if cx - r < gap || cy - r < gap || cx + r > w - gap || cy + r > h - gap {
                continue;
            }
            if holes
                .iter()
                .any(|&(x, y, q)| ((x - cx).m_powi(2) + (y - cy).m_powi(2)).sqrt() < r + q + gap)
            {
                continue;
            }
            holes.push((cx, cy, r));
            let n = 3 + (rng.unit() * 80.0) as u32;
            let dent = if rng.unit() < 0.7 { 0.0 } else { 0.2 };
            let mut hole = ring(rng, cx, cy, r, n, dent);
            hole.reverse();
            rings.push(hole);
        }
        perimeters::union_all(&[&vec![rings]])
    }

    #[test]
    fn a_certified_island_has_no_gaps() {
        let mut rng = Rng(0x2545_f491_4f6c_dd1d);
        let (ext, inner, spacing, spacing2) = (4200, 4500, 4071, 3921);
        let min_spacing = spacing * 6 / 10;
        let (mut certified, mut gapped) = (0, 0);
        for _ in 0..400 {
            for one in island(&mut rng) {
                let one: Shapes = vec![one];
                for loops in 1..=3u32 {
                    let mut chain: Vec<Shapes> = vec![perimeters::offset(&one, -(ext / 2))];
                    for k in 1..loops {
                        let d = if k == 1 { spacing2 } else { spacing };
                        let next = perimeters::offset(
                            &perimeters::offset(chain.last().unwrap(), -(d + min_spacing / 2 - 1)),
                            min_spacing / 2 - 1,
                        );
                        let empty = next.is_empty();
                        chain.push(next);
                        if empty {
                            break;
                        }
                    }
                    let got = orca_gaps(&one, &chain, loops, ext, inner, spacing, spacing2, 0.2);
                    let none = got.0.is_empty() && got.1.is_empty();
                    if no_gaps(&chain, loops, spacing, spacing2, narrowest(ext, inner)) {
                        certified += 1;
                        assert!(none, "certified, yet gaps: {one:?} {loops}");
                    }
                    gapped += usize::from(!none);
                }
            }
        }
        // Many islands are certified, and the generator does make gaps elsewhere.
        assert!(certified > 300 && gapped > 30, "{certified} {gapped}");
    }
}
