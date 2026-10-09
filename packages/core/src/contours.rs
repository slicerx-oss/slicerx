// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Stage 2: cut each part at a layer's plane and join the segments into loops.
//!
//! Triangles are bucketed by the layers they cross once per session. A
//! segment runs from the point on the triangle's falling edge to the point on
//! its rising edge, which leaves the solid on the left, so outer loops come
//! out counterclockwise and holes clockwise. Segments join through the id of
//! the mesh edge they share, never through float comparison. A vertex on the
//! plane counts as above it (`layers::on_or_above`, as Orca's slicer has it).

use crate::geom::{Point, Polygon};
use crate::layers::{LayerPlan, on_or_above};

/// One part, welded and moved to plate coordinates.
#[derive(Debug, Clone, Default)]
pub(crate) struct PreparedPart {
    pub(crate) slot: u8,
    pub(crate) verts: Vec<[f64; 3]>,
    pub(crate) tris: Vec<[u32; 3]>,
    /// CSR: triangles crossing layer i are `bucket_tris[bucket_start[i]..bucket_start[i + 1]]`.
    bucket_start: Vec<u32>,
    bucket_tris: Vec<u32>,
    /// Painted pieces of the surface, in mm (multi-color paint).
    pub(crate) paint: crate::paint::Facets,
}

impl PreparedPart {
    pub(crate) fn new(slot: u8, verts: Vec<[f64; 3]>, tris: Vec<[u32; 3]>, plan: &LayerPlan) -> Self {
        let n = plan.slice_z.len();
        let spans: Vec<(usize, usize)> = crate::par::map_fine(&tris, |t| {
            let z = t.map(|i| verts.get(i as usize).map_or(0.0, |v| v[2]));
            let lo = z[0].min(z[1]).min(z[2]);
            let hi = z[0].max(z[1]).max(z[2]);
            let cut = plan.cutting(lo, hi);
            (cut.start, cut.end)
        });
        let mut counts = vec![0u32; n + 1];
        for &(a, b) in &spans {
            for c in counts.get_mut(a..b).unwrap_or(&mut []) {
                *c += 1;
            }
        }
        let mut bucket_start = Vec::with_capacity(n + 1);
        let mut acc = 0u32;
        for c in counts.iter().take(n) {
            bucket_start.push(acc);
            acc += c;
        }
        bucket_start.push(acc);
        let mut fill = bucket_start.clone();
        let mut bucket_tris = vec![0u32; acc as usize];
        for (ti, &(a, b)) in spans.iter().enumerate() {
            for layer in a..b {
                if let Some(pos) = fill.get_mut(layer) {
                    if let Some(slot) = bucket_tris.get_mut(*pos as usize) {
                        #[allow(clippy::cast_possible_truncation, reason = "triangle counts fit in u32")]
                        {
                            *slot = ti as u32;
                        }
                    }
                    *pos += 1;
                }
            }
        }
        Self {
            slot,
            verts,
            tris,
            bucket_start,
            bucket_tris,
            paint: Vec::new(),
        }
    }

    pub(crate) fn with_paint(mut self, paint: crate::paint::Facets) -> Self {
        self.paint = paint;
        self
    }

    /// Mesh edges without a matching edge running the other way.
    pub(crate) fn open_edges(&self) -> usize {
        count_open_edges(&self.tris)
    }

    fn bucket(&self, layer: usize) -> &[u32] {
        let a = self.bucket_start.get(layer).copied().unwrap_or(0) as usize;
        let b = self.bucket_start.get(layer + 1).copied().unwrap_or(0) as usize;
        self.bucket_tris.get(a..b).unwrap_or(&[])
    }

    /// Cuts the part at `z` (the plane of `layer`) and appends closed loops to
    /// `out`. Returns the number of chains that did not close.
    pub(crate) fn slice(&self, layer: usize, z: f64, out: &mut Vec<Polygon>) -> usize {
        let tris = self.bucket(layer);
        let mut segs: Vec<Seg> = Vec::with_capacity(tris.len());
        for &ti in tris {
            let Some(&t) = self.tris.get(ti as usize) else {
                continue;
            };
            let [i0, i1, i2] = t;
            let (Some(a), Some(b), Some(c)) = (
                self.verts.get(i0 as usize),
                self.verts.get(i1 as usize),
                self.verts.get(i2 as usize),
            ) else {
                continue;
            };
            let (a, b, c) = (on_or_above(a[2], z), on_or_above(b[2], z), on_or_above(c[2], z));
            let mut down = None;
            let mut up = None;
            for (ea, eb, ia, ib) in [(a, b, i0, i1), (b, c, i1, i2), (c, a, i2, i0)] {
                if ea && !eb {
                    down = Some((ia, ib));
                } else if !ea && eb {
                    up = Some((ia, ib));
                }
            }
            let (Some(d), Some(u)) = (down, up) else { continue };
            segs.push(Seg {
                from_key: edge_key(d.0, d.1),
                to_key: edge_key(u.0, u.1),
                from: self.cut(d.0, d.1, z),
                to: self.cut(u.0, u.1, z),
            });
        }
        join(&segs, out)
    }

    /// Where the edge (a, b) crosses `z`, computed from the lower vertex id so
    /// both triangles sharing the edge get the same bits.
    fn cut(&self, a: u32, b: u32, z: f64) -> Point {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        let (Some(p), Some(q)) = (self.verts.get(lo as usize), self.verts.get(hi as usize)) else {
            return Point::default();
        };
        let dz = q[2] - p[2];
        // A vertex counted onto the plane may sit a hair off it.
        let t = if dz == 0.0 {
            0.0
        } else {
            ((z - p[2]) / dz).clamp(0.0, 1.0)
        };
        Point::from_mm(p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]))
    }
}

#[derive(Debug, Clone, Copy)]
struct Seg {
    from_key: u64,
    to_key: u64,
    from: Point,
    to: Point,
}

fn edge_key(a: u32, b: u32) -> u64 {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    (u64::from(lo) << 32) | u64::from(hi)
}

/// A chain of segments that did not close by itself, with the mesh edges at its two ends.
struct Open {
    points: Polygon,
    start: u64,
    end: u64,
    consumed: bool,
}

/// Joins segments into loops (Orca `TriangleMeshSlicer::make_loops`): chains by the triangle edges they
/// share, then the chains that did not close are joined end to start over a shared edge, then also end
/// to end (pieces of opposite orientation), then over gaps up to 2 mm. What still does not close is
/// dropped and counted.
fn join(segs: &[Seg], out: &mut Vec<Polygon>) -> usize {
    #[allow(clippy::cast_possible_truncation, reason = "segment counts fit in u32")]
    let mut index: Vec<(u64, u32)> = segs
        .iter()
        .enumerate()
        .map(|(i, s)| (s.from_key, i as u32))
        .collect();
    index.sort_unstable();
    let find = |key: u64| -> Option<usize> {
        let i = index.partition_point(|&(k, _)| k < key);
        index.get(i).filter(|&&(k, _)| k == key).map(|&(_, s)| s as usize)
    };
    let mut used = vec![false; segs.len()];
    let mut open: Vec<Open> = Vec::new();
    for start in 0..segs.len() {
        if used.get(start).copied().unwrap_or(true) {
            continue;
        }
        let mut poly: Polygon = Vec::new();
        let mut cur = start;
        let mut last_to = (0u64, Point::default());
        let closed = loop {
            let Some(s) = segs.get(cur) else { break false };
            if let Some(u) = used.get_mut(cur) {
                *u = true;
            }
            if poly.last() != Some(&s.from) {
                poly.push(s.from);
            }
            last_to = (s.to_key, s.to);
            match find(s.to_key) {
                Some(next) if next == start => break true,
                Some(next) if !used.get(next).copied().unwrap_or(true) => cur = next,
                _ => break false,
            }
        };
        if closed {
            if poly.first() == poly.last() {
                poly.pop();
            }
            if poly.len() >= 3 {
                out.push(poly);
            }
        } else {
            if poly.last() != Some(&last_to.1) {
                poly.push(last_to.1);
            }
            let first_key = segs.get(start).map_or(0, |s| s.from_key);
            open.push(Open {
                points: poly,
                start: first_key,
                end: last_to.0,
                consumed: false,
            });
        }
    }
    if open.is_empty() {
        return 0;
    }
    chain_exact(&mut open, out, false);
    chain_exact(&mut open, out, true);
    chain_gaps(&mut open, out, crate::geom::mm(2.0), false);
    chain_gaps(&mut open, out, crate::geom::mm(2.0), true);
    open.iter()
        .filter(|o| !o.consumed && !o.points.is_empty())
        .count()
}

fn length(p: &[Point]) -> f64 {
    p.windows(2).map(|w| w[0].dist_mm(w[1])).sum()
}

/// Indices of the chains not yet used, longest first (Orca seeds new loops from the longer chains).
fn by_length(open: &[Open]) -> Vec<usize> {
    let mut ids: Vec<usize> = (0..open.len()).filter(|&i| !open[i].consumed).collect();
    let lens: Vec<f64> = open.iter().map(|o| length(&o.points)).collect();
    crate::sorting::sort_by(&mut ids, |&a, &b| lens[b].total_cmp(&lens[a]));
    ids
}

/// A closed chain becomes a loop; one patched from pieces of both orientations turns counterclockwise.
fn emit(mut points: Polygon, mixed: bool, out: &mut Vec<Polygon>) {
    if points.len() >= 3 {
        if mixed && crate::geom::area2(&points) < 0 {
            points.reverse();
        }
        out.push(points);
    }
}

/// Orca `chain_open_polylines_exact`: a chain continues with the chain that starts at the mesh edge where
/// it ends (or, `reversed`, also one that ends there, walked backward), until it comes back to its start.
fn chain_exact(open: &mut [Open], out: &mut Vec<Polygon>, reversed: bool) {
    for i in by_length(open) {
        if open[i].consumed {
            continue;
        }
        open[i].consumed = true;
        let mut mixed = false;
        loop {
            let end = open[i].end;
            let next = (0..open.len()).find_map(|j| {
                if j == i || open[j].consumed {
                    None
                } else if open[j].start == end {
                    Some((j, false))
                } else if reversed && open[j].end == end {
                    Some((j, true))
                } else {
                    None
                }
            });
            let Some((j, flip)) = next else {
                open[i].consumed = false;
                break;
            };
            let mut more = std::mem::take(&mut open[j].points);
            let new_end = if flip { open[j].start } else { open[j].end };
            if flip {
                more.reverse();
                mixed = true;
            }
            open[j].consumed = true;
            open[i].points.extend(more.into_iter().skip(1));
            open[i].end = new_end;
            if open[i].end == open[i].start {
                let mut points = std::mem::take(&mut open[i].points);
                points.pop();
                emit(points, mixed, out);
                break;
            }
        }
    }
}

/// Orca `chain_open_polylines_close_gaps`: a chain continues with the chain whose start (or, `reversed`,
/// either end) lies nearest its end within `max_gap`, and closes once its own start is within reach and
/// nearer than any other chain (or, when another is nearer, once the gap is under 0.3 of its length).
fn chain_gaps(open: &mut [Open], out: &mut Vec<Polygon>, max_gap: i32, reversed: bool) {
    let max2 = f64::from(max_gap) * f64::from(max_gap);
    let d2 = |a: Point, b: Point| {
        let (dx, dy) = (f64::from(a.x) - f64::from(b.x), f64::from(a.y) - f64::from(b.y));
        dx * dx + dy * dy
    };
    for i in by_length(open) {
        if open[i].consumed || open[i].points.is_empty() {
            continue;
        }
        open[i].consumed = true;
        let mut joined = 1;
        while let (Some(&first), Some(&last)) = (open[i].points.first(), open[i].points.last()) {
            let mut best: Option<(usize, bool, f64)> = None;
            for (j, o) in open.iter().enumerate() {
                if j == i || o.consumed || o.points.is_empty() {
                    continue;
                }
                let mut ends = vec![(false, o.points[0])];
                if reversed {
                    ends.push((true, o.points[o.points.len() - 1]));
                }
                for (flip, p) in ends {
                    let d = d2(last, p);
                    if d <= max2 && best.is_none_or(|(_, _, bd)| d < bd) {
                        best = Some((j, flip, d));
                    }
                }
            }
            let closing = d2(last, first);
            let mut closed = closing < max2;
            if let Some((_, _, nd)) = best
                && closed
                && closing < nd
            {
                closed = closing.sqrt() < 0.3 * length(&open[i].points) * crate::geom::SCALE;
            }
            if closed {
                let mut points = std::mem::take(&mut open[i].points);
                if closing == 0.0 {
                    points.pop();
                }
                emit(points, reversed && joined > 1, out);
                break;
            }
            let Some((j, flip, _)) = best else {
                open[i].consumed = false;
                break;
            };
            let mut more = std::mem::take(&mut open[j].points);
            if flip {
                more.reverse();
            }
            if more.first() == Some(&last) {
                more.remove(0);
            }
            open[i].points.extend(more);
            open[j].consumed = true;
            joined += 1;
        }
    }
}

/// Edges not matched by exactly one edge running the other way. Each edge
/// becomes an undirected key with its direction in the low bit; after one
/// sort, a closed edge is a key seen once in each direction.
fn count_open_edges(tris: &[[u32; 3]]) -> usize {
    let mut keys: Vec<u64> = tris
        .iter()
        .flat_map(|t| [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])])
        .map(|(a, b)| {
            let (lo, hi, dir) = if a < b { (a, b, 0) } else { (b, a, 1) };
            (u64::from(lo) << 33) | (u64::from(hi) << 1) | dir
        })
        .collect();
    crate::par::sort(&mut keys);
    let mut open = 0;
    let mut i = 0;
    while let Some(&k) = keys.get(i) {
        let edge = k >> 1;
        let run = keys
            .get(i..)
            .map_or(0, |r| r.iter().take_while(|&&x| x >> 1 == edge).count());
        let fwd = keys
            .get(i..i + run)
            .map_or(0, |r| r.iter().filter(|&&x| x & 1 == 0).count());
        let rev = run - fwd;
        open += fwd.abs_diff(rev);
        i += run.max(1);
    }
    open
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::area2;

    fn cube() -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
        let v = vec![
            [0.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
            [10.0, 10.0, 0.0],
            [0.0, 10.0, 0.0],
            [0.0, 0.0, 10.0],
            [10.0, 0.0, 10.0],
            [10.0, 10.0, 10.0],
            [0.0, 10.0, 10.0],
        ];
        let t = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        (v, t)
    }

    #[test]
    fn cube_slices_to_one_ccw_square() {
        let (v, t) = cube();
        let plan = LayerPlan::new(10.0, 0.2, 0.2);
        let part = PreparedPart::new(1, v, t, &plan);
        assert_eq!(part.open_edges(), 0);
        let mut out = Vec::new();
        let open = part.slice(10, plan.slice_z[10], &mut out);
        assert_eq!(open, 0);
        assert_eq!(out.len(), 1);
        assert!(out[0].len() >= 4);
        assert_eq!(area2(&out[0]), 2 * 100_000 * 100_000);
    }

    #[test]
    fn a_seam_of_unwelded_vertices_still_closes_the_loop() {
        // The x = 10 side uses its own copies of its four corners, so its edges share no ids with the
        // sides next to it: the chain breaks at both ends of that side and is joined again over the gap.
        let (mut v, mut t) = cube();
        for i in [1usize, 2, 6, 5] {
            v.push(v[i]);
        }
        t[6] = [8, 9, 10];
        t[7] = [8, 10, 11];
        let plan = LayerPlan::new(10.0, 0.2, 0.2);
        let part = PreparedPart::new(1, v, t, &plan);
        let mut out = Vec::new();
        let open = part.slice(10, plan.slice_z[10], &mut out);
        assert_eq!(open, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(area2(&out[0]), 2 * 100_000 * 100_000);
    }
}
