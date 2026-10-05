// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The medial axis of a thin shape as variable-width lines, for gap fill.
//!
//! Orca (`Geometry::MedialAxis`) takes the Voronoi diagram of the shape, keeps the edges whose
//! local thickness lies between a minimum and a maximum, and chains them into polylines whose width
//! follows the thickness. The skeleton graph Arachne builds is that diagram, so the same edges come
//! from it: the ones that run along the shape, not across it to the outline, between two outline
//! segments that face each other (Orca `MedialAxis::validate_edge`).

use super::graph::{P, dist};
use super::voronoi;
use crate::fm::Fm as _;
use std::collections::HashMap;

/// A line down the middle of a strip: points and the thickness at each, nm.
pub(crate) type Thick = (Vec<P>, Vec<i64>);

/// One piece of the axis: a segment with thickness at both ends.
#[derive(Clone, Copy)]
struct Seg {
    a: usize,
    b: usize,
}

/// The medial axis of `rings` (outer counterclockwise, holes clockwise) where the shape is between
/// `min` and `max` thick, nm. Dead-end branches shorter than twice their width are dropped.
pub(crate) fn lines(rings: &[Vec<P>], min: i64, max: i64) -> Vec<Thick> {
    let prm = voronoi::Params {
        transitioning_angle: 10f64.to_radians(),
        discretization_step: super::beading::nm(0.2),
        keep: false,
    };
    let Some(g) = voronoi::build(rings, &prm) else {
        return Vec::new();
    };
    let sources = cell_sources(&g);
    // Points of the axis: original nodes, plus points where an edge crosses the minimum thickness.
    let mut pts: Vec<(P, i64)> = Vec::new();
    let mut node_id: HashMap<usize, usize> = HashMap::new();
    let mut segs: Vec<Seg> = Vec::new();
    let add = |pts: &mut Vec<(P, i64)>, p: P, w: i64| -> usize {
        pts.push((p, w));
        pts.len() - 1
    };
    for e in g.live_edges() {
        let Some(twin) = g.edges.get(e).and_then(|x| x.twin) else {
            continue;
        };
        if e > twin {
            continue;
        }
        let (Some(f), Some(t)) = (g.edges.get(e).map(|x| x.from), g.edges.get(e).map(|x| x.to)) else {
            continue;
        };
        let (Some(nf), Some(nt)) = (g.nodes.get(f), g.nodes.get(t)) else {
            continue;
        };
        let len = dist(nf.p, nt.p);
        let d_r = (nf.dist - nt.dist).abs();
        // A rib runs straight to the outline: its radius changes as fast as it is long.
        if len == 0 || d_r * 100 >= len * 99 {
            continue;
        }
        let (wf, wt) = (2 * nf.dist, 2 * nt.dist);
        if wf.max(wt) < min || wf.min(wt) > max {
            continue;
        }
        // Orca drops an edge between two segments that do not face each other (a corner, not a strip) unless
        // it is shorter than the minimum width, and an edge that touches the outline unless it runs between
        // two facing segments (the tip of a wedge).
        let touches = wf.min(wt) < EPSILON;
        match (sources.get(e), sources.get(twin)) {
            (Some(Some(l)), Some(Some(r))) => {
                if !facing(*l, *r) && (touches || len >= min) {
                    continue;
                }
            }
            _ => {
                if touches {
                    continue;
                }
            }
        }
        // Clip to the thickness range by interpolation along the edge.
        let at = |w: i64| -> P {
            let t = (w - wf) as f64 / (wt - wf) as f64;
            P::new(
                nf.p.x + ((nt.p.x - nf.p.x) as f64 * t).round() as i64,
                nf.p.y + ((nt.p.y - nf.p.y) as f64 * t).round() as i64,
            )
        };
        let mut start = (nf.p, wf);
        let mut end = (nt.p, wt);
        if wf < min {
            start = (at(min), min);
        } else if wf > max {
            start = (at(max), max);
        }
        if wt < min {
            end = (at(min), min);
        } else if wt > max {
            end = (at(max), max);
        }
        let ia = *node_id
            .entry(f)
            .or_insert_with(|| add(&mut pts, start.0, start.1));
        let ib = *node_id.entry(t).or_insert_with(|| add(&mut pts, end.0, end.1));
        // A clipped end is its own point, not the shared node.
        let ia = if start.0 == nf.p {
            ia
        } else {
            add(&mut pts, start.0, start.1)
        };
        let ib = if end.0 == nt.p {
            ib
        } else {
            add(&mut pts, end.0, end.1)
        };
        segs.push(Seg { a: ia, b: ib });
    }
    g.recycle();
    finish(chains(&pts, &segs), rings, max)
}

/// Orca's `SCALED_EPSILON`, nm: thinner than this is no thickness.
const EPSILON: i64 = 100;

/// The outline segment each half-edge's cell is built around, as its two ends, or `None` for a cell built
/// around a corner. A cell's chain runs from the rib at one end of its source to the rib at the other, so
/// the first and last node of the chain are the source's ends, and a corner's chain starts and ends on it.
/// Every cell is walked the same way round, so two facing segments come out pointing apart.
#[allow(clippy::indexing_slicing, reason = "edge and node ids come from the graph")]
fn cell_sources(g: &super::graph::Graph) -> Vec<Option<(P, P)>> {
    let mut out = vec![None; g.edges.len()];
    let mut chain = Vec::new();
    for e in g.live_edges() {
        if g.edges[e].prev.is_some() {
            continue;
        }
        chain.clear();
        let mut at = e;
        chain.push(at);
        while let Some(n) = g.edges[at].next {
            if chain.len() > g.edges.len() {
                break;
            }
            at = n;
            chain.push(at);
        }
        let (a, b) = (g.nodes[g.edges[e].from].p, g.nodes[g.edges[at].to].p);
        let src = (a != b).then_some((a, b));
        for &c in &chain {
            out[c] = src;
        }
    }
    out
}

/// Whether two outline segments face each other: they point apart to within 22.5 degrees (Orca
/// `MedialAxis::validate_edge`, `PI / 8`). A corner's cell has no direction and passes.
#[allow(clippy::cast_precision_loss, reason = "coordinates of one layer, nm")]
fn facing(l: (P, P), r: (P, P)) -> bool {
    let (a, b) = (l.1.minus(l.0), r.1.minus(r.0));
    let (la, lb) = (a.len_f(), b.len_f());
    if la == 0.0 || lb == 0.0 {
        return true;
    }
    let cos = (a.x as f64 * b.x as f64 + a.y as f64 * b.y as f64) / (la * lb);
    cos <= (7.0 * std::f64::consts::PI / 8.0).m_cos()
}

/// A chained line and whether each end is free (no other axis edge meets it there).
type Chain = (Thick, bool, bool);

/// Chains the segments into polylines that break at junctions (Orca `MedialAxis::process_edge_neighbors`).
fn chains(pts: &[(P, i64)], segs: &[Seg]) -> Vec<Chain> {
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); pts.len()];
    for (i, s) in segs.iter().enumerate() {
        if let Some(v) = adj.get_mut(s.a) {
            v.push(i);
        }
        if let Some(v) = adj.get_mut(s.b) {
            v.push(i);
        }
    }
    let mut used = vec![false; segs.len()];
    let mut out: Vec<Chain> = Vec::new();
    let degree = |p: usize| adj.get(p).map_or(0, Vec::len);
    let other = |s: &Seg, p: usize| if s.a == p { s.b } else { s.a };
    // Start from ends and junctions first, so chains are maximal; loops are picked up after.
    let mut starts: Vec<usize> = (0..pts.len())
        .filter(|&p| degree(p) != 2 && degree(p) > 0)
        .collect();
    starts.extend((0..pts.len()).filter(|&p| degree(p) == 2));
    for start in starts {
        let Some(list) = adj.get(start).cloned() else {
            continue;
        };
        for first in list {
            if used.get(first).copied().unwrap_or(true) {
                continue;
            }
            let mut path = vec![start];
            let mut at = start;
            let mut seg = first;
            loop {
                if let Some(u) = used.get_mut(seg) {
                    *u = true;
                }
                let Some(s) = segs.get(seg) else { break };
                at = other(s, at);
                path.push(at);
                if degree(at) != 2 {
                    break;
                }
                let next = adj
                    .get(at)
                    .and_then(|l| l.iter().copied().find(|&n| !used.get(n).copied().unwrap_or(true)));
                match next {
                    Some(n) => seg = n,
                    None => break,
                }
            }
            let line: Thick = (
                path.iter().filter_map(|&p| pts.get(p).map(|x| x.0)).collect(),
                path.iter().filter_map(|&p| pts.get(p).map(|x| x.1)).collect(),
            );
            let free = |p: Option<&usize>| p.is_some_and(|&p| degree(p) == 1);
            if line.0.len() >= 2 {
                out.push((line, free(path.first()), free(path.last())));
            }
        }
    }
    out
}

fn length(l: &[P]) -> i64 {
    l.windows(2)
        .map(|w| w.first().zip(w.get(1)).map_or(0, |(p, q)| dist(*p, *q)))
        .sum()
}

/// Where segment `a`-`b` crosses the first edge of `ring` it meets, in ring order.
#[allow(clippy::cast_possible_truncation, reason = "a point on the segment, nm")]
fn first_crossing(ring: &[P], a: P, b: P) -> Option<P> {
    let n = ring.len();
    for i in 0..n {
        let (Some(&c), Some(&d)) = (ring.get(i), ring.get((i + 1) % n)) else {
            continue;
        };
        let (rx, ry) = ((b.x - a.x) as f64, (b.y - a.y) as f64);
        let (sx, sy) = ((d.x - c.x) as f64, (d.y - c.y) as f64);
        let den = rx * sy - ry * sx;
        if den == 0.0 {
            continue;
        }
        let (qx, qy) = ((c.x - a.x) as f64, (c.y - a.y) as f64);
        let t = (qx * sy - qy * sx) / den;
        let u = (qx * ry - qy * rx) / den;
        if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
            return Some(P::new(
                a.x + (rx * t).round() as i64,
                a.y + (ry * t).round() as i64,
            ));
        }
    }
    None
}

fn seg_dist(p: P, a: P, b: P) -> f64 {
    #[allow(clippy::cast_precision_loss, reason = "coordinates of one layer, nm")]
    let (px, py, ax, ay, bx, by) = (
        p.x as f64, p.y as f64, a.x as f64, a.y as f64, b.x as f64, b.y as f64,
    );
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 {
        (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (px - ax - t * dx).m_hypot(py - ay - t * dy)
}

/// What Orca's `ExPolygon::medial_axis` does with the chained axis: free ends that are not on the outline
/// run on to the outer contour (at most `max` further along the end segment), lines with a free end that
/// are shorter than twice the widest line go, and the lines left meeting end to end are joined again.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "nm coordinates"
)]
fn finish(mut pp: Vec<Chain>, rings: &[Vec<P>], max: i64) -> Vec<Thick> {
    let contour = rings
        .iter()
        .find(|r| super::area2(r) > 0)
        .or_else(|| rings.first());
    let on_boundary = |p: P| {
        rings.iter().any(|r| {
            let n = r.len();
            (0..n).any(|i| match (r.get(i), r.get((i + 1) % n)) {
                (Some(&a), Some(&b)) => seg_dist(p, a, b) <= 100.0,
                _ => false,
            })
        })
    };
    let max_w = pp.iter().flat_map(|c| c.0.1.iter().copied()).max().unwrap_or(0);
    let extend = |from: P, to: P, mid_if_two: bool, other: P| -> Option<P> {
        // The segment from `from` toward `to` run on past `to` by `max`.
        let from = if mid_if_two {
            P::new(i64::midpoint(other.x, to.x), i64::midpoint(other.y, to.y))
        } else {
            from
        };
        let (dx, dy) = ((to.x - from.x) as f64, (to.y - from.y) as f64);
        let l = dx.m_hypot(dy);
        if l == 0.0 {
            return None;
        }
        let far = P::new(
            to.x + (dx / l * max as f64).round() as i64,
            to.y + (dy / l * max as f64).round() as i64,
        );
        first_crossing(contour?, from, far)
    };
    let mut removed = false;
    let mut kept: Vec<Chain> = Vec::with_capacity(pp.len());
    for (mut line, fa, fb) in pp.drain(..) {
        let n = line.0.len();
        if fa
            && !on_boundary(line.0[0])
            && let Some(p) = extend(line.0[1], line.0[0], n == 2, line.0[1])
        {
            line.0[0] = p;
        }
        if fb
            && !on_boundary(line.0[n - 1])
            && let Some(p) = extend(line.0[n - 2], line.0[n - 1], n == 2, line.0[n - 2])
        {
            line.0[n - 1] = p;
        }
        if (fa || fb) && length(&line.0) < 2 * max_w {
            removed = true;
            continue;
        }
        kept.push((line, fa, fb));
    }
    if removed {
        let mut i = 0;
        while i < kept.len() {
            if kept[i].1 && kept[i].2 {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while j < kept.len() {
                let (af, al) = (kept[i].0.0[0], *kept[i].0.0.last().unwrap_or(&kept[i].0.0[0]));
                let (bf, bl) = (kept[j].0.0[0], *kept[j].0.0.last().unwrap_or(&kept[j].0.0[0]));
                let reverse = |c: &mut Chain| {
                    c.0.0.reverse();
                    c.0.1.reverse();
                    std::mem::swap(&mut c.1, &mut c.2);
                };
                if al == bl {
                    reverse(&mut kept[j]);
                } else if af == bl {
                    reverse(&mut kept[i]);
                    reverse(&mut kept[j]);
                } else if af == bf {
                    reverse(&mut kept[i]);
                } else if al != bf {
                    j += 1;
                    continue;
                }
                let other = kept.remove(j);
                kept[i].0.0.extend(other.0.0.into_iter().skip(1));
                kept[i].0.1.extend(other.0.1.into_iter().skip(1));
                kept[i].2 = other.2;
                j = i + 1;
            }
            i += 1;
        }
    }
    kept.into_iter().map(|c| c.0).collect()
}

#[cfg(test)]
mod tests {
    use super::super::{medial_lines, perimeters};
    use crate::fm::Fm as _;
    use i_overlay::i_float::int::point::IntPoint;

    fn strip(len_mm: f64, w_mm: f64) -> perimeters::Shapes {
        let (l, w) = ((len_mm * 10_000.0) as i32, (w_mm * 10_000.0) as i32);
        vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(l, 0),
            IntPoint::new(l, w),
            IntPoint::new(0, w),
        ]]]
    }

    #[test]
    fn a_thin_strip_gets_one_line_as_wide_as_the_strip() {
        let lines = medial_lines(&strip(30.0, 0.16), 0.05, 0.76);
        assert_eq!(lines.len(), 1, "{lines:?}");
        let Some(line) = lines.first() else { return };
        let len: f64 = line
            .points
            .windows(2)
            .map(|w| {
                let (a, b) = (w[0], w[1]);
                f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y))
            })
            .sum();
        assert!(len > 280_000.0, "{len}");
        let mid = line.widths[line.widths.len() / 2];
        assert!((mid - 1_600).abs() < 60, "{mid}");
    }

    fn triangle(pts: [(f64, f64); 3]) -> perimeters::Shapes {
        vec![vec![
            pts.iter()
                .map(|&(x, y)| IntPoint::new((x * 10_000.0) as i32, (y * 10_000.0) as i32))
                .collect(),
        ]]
    }

    #[test]
    fn a_square_corner_gets_nothing() {
        // The wedge a wall leaves in a square corner: its axis runs between segments that do not face each
        // other, which Orca's medial axis drops, so it gets no bead.
        assert!(medial_lines(&triangle([(0.0, 0.0), (0.6, 0.0), (0.0, 0.6)]), 0.05, 0.76).is_empty());
    }

    #[test]
    fn a_long_thin_wedge_keeps_its_line() {
        // Sides 2.3 degrees apart face each other, so the wedge narrowing to a point keeps its bead.
        let lines = medial_lines(&triangle([(0.0, 0.0), (10.0, 0.2), (0.0, 0.4)]), 0.05, 0.76);
        assert_eq!(lines.len(), 1, "{lines:?}");
    }

    #[test]
    fn a_strip_too_thin_gets_nothing() {
        assert!(medial_lines(&strip(30.0, 0.03), 0.05, 0.76).is_empty());
    }
}
