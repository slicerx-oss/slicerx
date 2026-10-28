// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Post-processing of the wall lines the skeleton makes: stitching the pieces into closed walls,
//! dropping lines that are too short to print, simplifying, and splitting off the zero-width
//! contour that marks where the infill area starts.

use super::graph::{Junction, P, dist};
use super::skeleton::Line;

fn polyline_length(line: &Line) -> i64 {
    line.junctions
        .windows(2)
        .map(|w| dist(w[0].p, w[1].p))
        .sum::<i64>()
        + if line.is_closed && line.junctions.len() > 1 {
            dist(line.junctions[0].p, line.junctions[line.junctions.len() - 1].p)
        } else {
            0
        }
}

/// Joins the lines of one inset that end next to each other, into longer lines and closed walls.
/// Even (wall) lines keep their direction; odd (gap filler) lines may be reversed, and the two kinds
/// never connect. Returns the open lines and the closed ones.
pub(crate) fn stitch(lines: &[Line], max_stitch: i64, snap: i64) -> (Vec<Line>, Vec<Line>) {
    let mut processed = vec![false; lines.len()];
    let mut open_out: Vec<Line> = Vec::new();
    let mut closed_out: Vec<Line> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if processed[i] {
            continue;
        }
        processed[i] = true;
        let mut chain: Vec<Junction> = line.junctions.clone();
        let mut should_close = line.is_odd;
        let mut closed = false;
        for reverse in [false, true] {
            if reverse {
                chain.reverse();
            }
            let mut chain_length: i64 = chain.windows(2).map(|w| dist(w[0].p, w[1].p)).sum();
            while let (Some(from), Some(front)) = (chain.last().map(|j| j.p), chain.first().map(|j| j.p)) {
                // (distance, line, at its start, closes the chain)
                let mut best: Option<(i64, usize, bool, bool)> = None;
                for (k, cand) in lines.iter().enumerate() {
                    if cand.is_odd != line.is_odd {
                        continue;
                    }
                    for at_start in [true, false] {
                        let Some(end) = (if at_start {
                            cand.junctions.first()
                        } else {
                            cand.junctions.last()
                        }) else {
                            continue;
                        };
                        let mut d = dist(end.p, from);
                        if d > max_stitch {
                            continue;
                        }
                        let mut closing = false;
                        let to_front = end.p.minus(front);
                        if to_front.dot(to_front) < snap * snap {
                            if chain_length + d < 3 * max_stitch || chain.len() <= 2 {
                                continue;
                            }
                            closing = true;
                            // Closing a polygon made of even walls is not preferred over going on.
                            d += if should_close { -nm_001() } else { nm_001() };
                        } else if processed[k] {
                            continue;
                        }
                        // Connecting at the far end would reverse the line; only odd lines may be.
                        let would_reverse = at_start == reverse;
                        if !cand.is_odd && would_reverse {
                            continue;
                        }
                        if best.is_none_or(|(bd, ..)| d < bd) {
                            best = Some((d, k, at_start, closing));
                        }
                    }
                }
                let Some((_, k, at_start, closing)) = best else {
                    break;
                };
                if closing {
                    closed = true;
                    break;
                }
                let cand = &lines[k];
                let entry = if at_start {
                    cand.junctions.first()
                } else {
                    cand.junctions.last()
                };
                let seg = entry.map_or(0, |e| dist(from, e.p));
                let old = chain.len();
                let mut add: Vec<Junction> = if at_start {
                    cand.junctions.clone()
                } else {
                    cand.junctions.iter().rev().copied().collect()
                };
                if seg < snap && !add.is_empty() {
                    add.remove(0);
                }
                chain.extend(add);
                for j in old.max(1)..chain.len() {
                    chain_length += dist(chain[j].p, chain[j - 1].p);
                }
                should_close = should_close && !cand.is_odd;
                processed[k] = true;
            }
            if closed {
                if reverse {
                    chain.reverse();
                }
                break;
            }
        }
        if closed {
            closed_out.push(Line {
                inset_idx: line.inset_idx,
                is_odd: line.is_odd,
                is_closed: true,
                junctions: chain,
            });
        } else {
            if !line.is_odd {
                // The second pass reversed the chain; a wall line keeps the direction it started in.
                chain.reverse();
            }
            open_out.push(Line {
                inset_idx: line.inset_idx,
                is_odd: line.is_odd,
                is_closed: false,
                junctions: chain,
            });
        }
    }
    (open_out, closed_out)
}

fn nm_001() -> i64 {
    super::beading::nm(0.01)
}

/// Drops odd open lines shorter than `factor` of their smallest width (`min_len` of it when the layer
/// is a top or bottom layer).
pub(crate) fn remove_small_lines(lines: &mut Vec<Line>, top_or_bottom: bool, min_length_factor: f64) {
    lines.retain(|l| {
        if !l.is_odd || l.is_closed {
            return true;
        }
        let min_w = l.junctions.iter().map(|j| j.w).min().unwrap_or(i64::MAX);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_precision_loss,
            reason = "lengths in nm"
        )]
        let limit = if top_or_bottom {
            min_w / 2
        } else {
            (min_w as f64 * min_length_factor) as i64
        };
        // A closed shape counts its way back too, so only open lines are measured as they are.
        polyline_length(l) >= limit
    });
}

/// Thins the junctions of a line: junctions that barely change the line are dropped, and short
/// segments are removed when the deviation stays small, keeping the extruded area within bounds.
pub(crate) fn simplify(
    line: &mut Line,
    smallest_segment_sq: i64,
    allowed_error_sq: i64,
    max_area_deviation: i64,
) {
    let min_size = if line.is_closed { 3 } else { 2 };
    if line.junctions.len() <= min_size {
        return;
    }
    let j = &line.junctions;
    let n = j.len();
    let closed = line.is_closed;
    let mut out: Vec<Junction> = vec![j[0]];
    let mut previous = j[0];
    let mut previous_previous = if closed { j[n - 2] } else { j[0] };
    let initial = j[1];
    let cross = |a: P, b: P| a.x * b.y - a.y * b.x;
    let mut accumulated = cross(previous.p, initial.p);
    let upper = n - usize::from(!closed);
    for idx in 1..upper {
        let is_last = idx + 1 == n;
        let current = if is_last { out[0] } else { j[idx] };
        if closed && out.len() + (n - idx) <= 3 {
            out.push(current);
            continue;
        }
        let spill = closed && idx + 2 >= n && idx + 2 - n < out.len();
        let next = if spill { out[idx + 2 - n] } else { j[idx + 1] };
        let removed_next = cross(current.p, next.p);
        let negative_closing = cross(next.p, previous.p);
        accumulated += removed_next;
        let length2 = {
            let d = current.p.minus(previous.p);
            d.dot(d)
        };
        let tiny = super::beading::nm(0.005);
        if length2 < tiny * tiny {
            continue;
        }
        let area_so_far = accumulated + negative_closing;
        let base2 = {
            let d = next.p.minus(previous.p);
            d.dot(d)
        };
        if base2 == 0 {
            continue;
        }
        #[allow(
            clippy::cast_precision_loss,
            clippy::cast_possible_truncation,
            reason = "areas in nm squared"
        )]
        let height2 = (area_so_far as f64 * area_so_far as f64 / base2 as f64) as i64;
        let area_error = extrusion_area_error(previous, current, next);
        if height2 <= tiny * tiny
            && distance_to_line(current.p, previous.p, next.p) <= super::beading::nm(0.005) as f64
            && area_error <= max_area_deviation
        {
            continue;
        }
        if length2 < smallest_segment_sq && height2 <= allowed_error_sq {
            let next_len2 = {
                let d = current.p.minus(next.p);
                d.dot(d)
            };
            if next_len2 > 4 * smallest_segment_sq {
                // The next segment is long: move this point to where both lines meet, when that is
                // close, and drop the one before it. Nearly parallel lines meet far away.
                if let Some(ip) = line_intersection(previous_previous.p, previous.p, current.p, next.p) {
                    let err = distance_to_line(ip, previous.p, current.p);
                    #[allow(clippy::cast_precision_loss, reason = "distances in nm")]
                    let ok = err * err <= allowed_error_sq as f64
                        && ip.within(previous.p, smallest_segment_sq)
                        && ip.within(current.p, smallest_segment_sq);
                    if ok {
                        let new = Junction {
                            p: ip,
                            w: current.w,
                            perimeter_index: current.perimeter_index,
                        };
                        if !out.is_empty() {
                            out.pop();
                            previous = previous_previous;
                        }
                        accumulated = removed_next;
                        previous_previous = previous;
                        previous = new;
                        out.push(new);
                        continue;
                    }
                }
            } else {
                continue;
            }
        }
        accumulated = removed_next;
        previous_previous = previous;
        previous = current;
        out.push(current);
    }
    if closed {
        let last = out.last().map(|l| l.p);
        if let (Some(first), Some(last)) = (out.first_mut(), last) {
            first.p = last;
        }
    } else {
        out.push(j[n - 1]);
    }
    line.junctions = out;
}

fn distance_to_line(p: P, a: P, b: P) -> f64 {
    let ab = b.minus(a);
    let l = ab.len_f();
    if l == 0.0 {
        return p.minus(a).len_f();
    }
    #[allow(clippy::cast_precision_loss, reason = "coordinates in nm")]
    let c = (ab.x as f64 * (p.y - a.y) as f64 - ab.y as f64 * (p.x - a.x) as f64).abs();
    c / l
}

/// Where the line through `a` and `b` meets the line through `c` and `d`. `None` when they are
/// parallel or meet farther out than a coordinate holds.
pub(crate) fn line_intersection(a: P, b: P, c: P, d: P) -> Option<P> {
    let (r, s) = (b.minus(a), d.minus(c));
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        reason = "coordinates in nm"
    )]
    {
        let denom = r.x as f64 * s.y as f64 - r.y as f64 * s.x as f64;
        if denom == 0.0 {
            return None;
        }
        let ca = c.minus(a);
        let t = (ca.x as f64 * s.y as f64 - ca.y as f64 * s.x as f64) / denom;
        // `i64::MAX as f64` is 2^63, the first value past the range; NaN fails the test too.
        let along = |v: i64| {
            let o = (v as f64 * t).round();
            (o.abs() < i64::MAX as f64).then_some(o as i64)
        };
        Some(P::new(
            a.x.checked_add(along(r.x)?)?,
            a.y.checked_add(along(r.y)?)?,
        ))
    }
}

/// How much extruded area the weighted-average width over the two segments gets wrong, when `b`
/// is removed from `a`, `b`, `c`.
fn extrusion_area_error(a: Junction, b: Junction, c: Junction) -> i64 {
    let ab = dist(b.p, a.p);
    let bc = dist(c.p, b.p);
    let width_diff = (b.w - a.w).abs().max((c.w - b.w).abs());
    if width_diff > 1 {
        let ab_weight = i64::midpoint(a.w, b.w);
        let bc_weight = i64::midpoint(b.w, c.w);
        let total = (ab + bc).max(1);
        let average = (ab * ab_weight + bc * bc_weight) / total;
        let ac = dist(c.p, a.p);
        ((ab_weight * ab + bc_weight * bc) - average * ac).abs()
    } else if ab > bc {
        width_diff * bc
    } else {
        width_diff * ab
    }
}

/// Splits off the lines made of zero-width junctions: they only mark the inner edge of the walled
/// area. Returns the remaining insets and the closed marker lines as rings.
pub(crate) fn separate_inner_contour(insets: Vec<Vec<Line>>) -> (Vec<Vec<Line>>, Vec<Vec<P>>) {
    let mut actual = Vec::new();
    let mut contour = Vec::new();
    for inset in insets {
        if inset.is_empty() {
            continue;
        }
        let is_contour = inset
            .iter()
            .filter_map(|l| l.junctions.first())
            .next_back()
            .is_some_and(|j| j.w == 0);
        if is_contour {
            for line in &inset {
                if line.is_odd {
                    continue;
                }
                if line.is_closed {
                    contour.push(line.junctions.iter().map(|j| j.p).collect());
                }
            }
        } else {
            actual.push(inset);
        }
    }
    (actual, contour)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One closed inner wall from the wedge in `walls_of_a_wedge_to_3_85_mm_stay_on_it`, as the skeleton gave it
    /// to the simplifier, nm: (x, y, width). The segment from (29537890, 299631) to (29937705, 305709) is short,
    /// and the long ones on either side are nearly parallel, so they meet about 10 m away.
    fn wedge_wall() -> Line {
        let pts: [(i64, i64, i64); 17] = [
            (19_669_277, 0, 598_460),
            (20_064_544, 155_623, 311_391),
            (29_537_890, 299_631, 599_540),
            (29_937_705, 305_709, 611_701),
            (36_429_481, 404_393, 809_160),
            (36_587_676, 610_338, 407_080),
            (58_094_332, 1_264_501, 407_080),
            (59_397_880, 1_304_150, 407_080),
            (59_397_880, 0, 407_080),
            (59_397_880, -1_304_150, 407_080),
            (58_094_332, -1_264_501, 407_080),
            (36_587_676, -610_338, 407_080),
            (36_429_481, -404_393, 809_160),
            (29_937_705, -305_709, 611_701),
            (29_537_890, -299_631, 599_540),
            (20_064_544, -155_623, 311_391),
            (19_669_277, 0, 598_460),
        ];
        Line {
            inset_idx: 1,
            is_odd: false,
            is_closed: true,
            junctions: pts
                .iter()
                .map(|&(x, y, w)| Junction {
                    p: P::new(x, y),
                    w,
                    perimeter_index: 1,
                })
                .collect(),
        }
    }

    /// Simplifying keeps every point of a line near the line: where the two long segments around a short one
    /// meet far away, the point stays where it is (0.5 mm resolution, 0.01 mm deviation, as the wedge had).
    #[test]
    fn simplify_keeps_a_point_whose_long_neighbors_meet_far_away() {
        let mut line = wedge_wall();
        let before: Vec<P> = line.junctions.iter().map(|j| j.p).collect();
        simplify(&mut line, 500_000 * 500_000, 10_000 * 10_000, 2_000_000);
        assert!(line.junctions.len() >= 3, "{:?}", line.junctions);
        let (x0, x1) = (19_669_277, 59_397_880);
        for j in &line.junctions {
            assert!(
                (x0..=x1).contains(&j.p.x) && j.p.y.abs() <= 1_304_150,
                "{:?} is off the line {before:?}",
                j.p
            );
        }
    }

    /// Lines that meet farther out than a coordinate holds have no meeting point; others meet as before.
    #[test]
    fn line_intersection_gives_none_past_the_coordinate_range() {
        let far = line_intersection(
            P::new(5, 0),
            P::new(1_000_000_005, 0),
            P::new(0, -4_000_000_000),
            P::new(4_000_000_000, -3_999_999_999),
        );
        assert_eq!(far, None);
        let near = line_intersection(P::new(0, 0), P::new(20, 0), P::new(10, 5), P::new(10, 7));
        assert_eq!(near, Some(P::new(10, 0)));
    }
}
