// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Travel planning on a finished layer: avoiding walls ("avoid crossing walls") and telling
//! whether a travel stays inside the part ("reduce infill retraction").
//!
//! The boundary travels may use is the layer's slice pulled in by one and a half perimeter
//! spacings, minus the top surfaces (shrunk a little), as rings. A travel that leaves the
//! region the slice shrunk by about half a wall covers is routed along those rings: where the
//! straight line enters a ring and where it last leaves it, the route follows the ring the short
//! way round; ends that are only close to a ring (walls sit outside the boundary) join it at the
//! closest point. The route is then straightened wherever a shortcut crosses no ring.

use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::output::{Feature, LayerPaths};
use crate::perimeters::{self, Shapes};

/// Offset along the inward normal that keeps route points off the ring itself, mm.
const EPS: f64 = 0.002;
/// Tolerance for "on the edge" in containment tests, mm.
const EDGE_TOL: f64 = 0.02;

type Pt = [f64; 2];

fn dist(a: Pt, b: Pt) -> f64 {
    (a[0] - b[0]).m_hypot(a[1] - b[1])
}

fn cross(o: Pt, a: Pt, b: Pt) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// True when the profile plans travels, so the layer keeps its regions.
pub(crate) fn wants_areas(cfg: &crate::config::PrintConfig) -> bool {
    crate::firmware::truthy(cfg, "reduce_crossing_wall")
        || crate::firmware::truthy(cfg, "reduce_infill_retraction")
        || crate::ironing::kind(cfg).is_some()
}

fn mm(p: i32) -> f64 {
    f64::from(p) / SCALE
}

/// Proper crossing of two segments (touching at an end does not count).
fn crosses_properly(p: Pt, q: Pt, a: Pt, b: Pt) -> bool {
    let (d1, d2) = (cross(p, q, a), cross(p, q, b));
    let (d3, d4) = (cross(a, b, p), cross(a, b, q));
    ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
}

fn closest_on_segment(p: Pt, a: Pt, b: Pt) -> Pt {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    [a[0] + t * dx, a[1] + t * dy]
}

// ------------------------------------------------------------------- shapes

fn shape_rings(shape: &[Vec<i_overlay::i_float::int::point::IntPoint<i32>>]) -> Vec<Vec<Pt>> {
    shape
        .iter()
        .map(|c| c.iter().map(|p| [mm(p.x), mm(p.y)]).collect())
        .collect()
}

/// One shape as rings (contour first) with the contour's bounds grown by the edge tolerance: a point
/// outside them is neither inside the shape nor near one of its rings, so it needs no ring scan.
struct Area {
    rings: Vec<Vec<Pt>>,
    reach: [f64; 4],
    /// The ring edges by horizontal band, for shapes with many edges.
    rows: Option<Rows>,
}

/// Ring edges binned by horizontal bands of the shape's bounds: an edge sits in every band its height
/// spans, once. Containment then reads only the edges at the height of the point, which give the same
/// answer as all of them (an edge farther than the tolerance in height is not near the point, and only an
/// edge spanning the point's height can cross the ray from it).
struct Rows {
    y0: f64,
    h: f64,
    /// Band `k` holds `edges[start[k]..start[k + 1]]`, each `(ring, index of its first point)`.
    start: Vec<u32>,
    edges: Vec<(u32, u32)>,
}

impl Rows {
    /// Edges of at least this many make the bands pay for themselves.
    const MIN_EDGES: usize = 48;

    fn new(rings: &[Vec<Pt>], reach: [f64; 4]) -> Option<Self> {
        let total: usize = rings.iter().map(Vec::len).sum();
        if total < Self::MIN_EDGES || reach[3].partial_cmp(&reach[1]) != Some(std::cmp::Ordering::Greater) {
            return None;
        }
        let bands = (total / 4).clamp(1, 4096);
        #[allow(clippy::cast_precision_loss, reason = "a band count")]
        let h = (reach[3] - reach[1]) / bands as f64;
        let mut rows = Self {
            y0: reach[1],
            h,
            start: vec![0; bands + 1],
            edges: Vec::new(),
        };
        let spans: Vec<(u32, u32, usize, usize)> = rings
            .iter()
            .enumerate()
            .flat_map(|(ri, r)| {
                let n = r.len();
                let rows = &rows;
                (0..n).filter_map(move |j| {
                    let (a, b) = (r.get(j)?, r.get((j + 1) % n)?);
                    let (lo, hi) = (rows.band(a[1].min(b[1])), rows.band(a[1].max(b[1])));
                    #[allow(clippy::cast_possible_truncation, reason = "ring and point counts fit u32")]
                    Some((ri as u32, j as u32, lo, hi))
                })
            })
            .collect();
        for &(_, _, lo, hi) in &spans {
            for k in lo..=hi {
                if let Some(c) = rows.start.get_mut(k + 1) {
                    *c += 1;
                }
            }
        }
        for k in 1..rows.start.len() {
            let prev = rows.start.get(k - 1).copied().unwrap_or(0);
            if let Some(v) = rows.start.get_mut(k) {
                *v += prev;
            }
        }
        let mut fill = rows.start.clone();
        rows.edges = vec![(0, 0); rows.start.last().copied().unwrap_or(0) as usize];
        for &(ri, j, lo, hi) in &spans {
            for k in lo..=hi {
                if let Some(f) = fill.get_mut(k) {
                    if let Some(slot) = rows.edges.get_mut(*f as usize) {
                        *slot = (ri, j);
                    }
                    *f += 1;
                }
            }
        }
        Some(rows)
    }

    /// The band of a height, clamped to the bands.
    fn band(&self, y: f64) -> usize {
        let last = self.start.len().saturating_sub(2);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "clamped to the bands"
        )]
        let k = ((y - self.y0) / self.h).floor().max(0.0) as usize;
        k.min(last)
    }

    fn band_edges(&self, k: usize) -> &[(u32, u32)] {
        match (self.start.get(k), self.start.get(k + 1)) {
            (Some(&s), Some(&e)) => self.edges.get(s as usize..e as usize).unwrap_or(&[]),
            _ => &[],
        }
    }

    /// [`in_shape`] read from the bands.
    fn in_shape(&self, rings: &[Vec<Pt>], p: Pt) -> bool {
        let edge = |ri: u32, j: u32| -> Option<(Pt, Pt)> {
            let r = rings.get(ri as usize)?;
            Some((*r.get(j as usize)?, *r.get((j as usize + 1) % r.len())?))
        };
        // Twice the tolerance in height keeps rounding in the distance on the safe side.
        let (lo, hi) = (self.band(p[1] - 2.0 * EDGE_TOL), self.band(p[1] + 2.0 * EDGE_TOL));
        for k in lo..=hi {
            for &(ri, j) in self.band_edges(k) {
                if let Some((a, b)) = edge(ri, j)
                    && dist(p, closest_on_segment(p, a, b)) <= EDGE_TOL
                {
                    return true;
                }
            }
        }
        // The parity of the crossings of each ring, one bit per ring: inside the contour and no hole.
        let crossing = self
            .band_edges(self.band(p[1]))
            .iter()
            .filter(|&&(ri, j)| edge(ri, j).is_some_and(|(a, b)| crosses_ray(a, b, p)));
        if rings.len() <= 64 {
            let mut parity = 0u64;
            for &(ri, _) in crossing {
                parity ^= 1 << ri;
            }
            return parity == 1;
        }
        let mut parity = vec![0u64; rings.len().div_ceil(64)];
        for &(ri, _) in crossing {
            if let Some(w) = parity.get_mut(ri as usize / 64) {
                *w ^= 1 << (ri % 64);
            }
        }
        parity.first() == Some(&1) && parity.iter().skip(1).all(|w| *w == 0)
    }
}

impl Area {
    fn new(shape: &[Vec<i_overlay::i_float::int::point::IntPoint<i32>>]) -> Self {
        let rings = shape_rings(shape);
        let b = rings
            .first()
            .into_iter()
            .flatten()
            .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
            });
        // Twice the tolerance keeps rounding in the ring tests on the safe side.
        let m = 2.0 * EDGE_TOL;
        let reach = [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
        Self {
            rows: Rows::new(&rings, reach),
            rings,
            reach,
        }
    }

    fn reaches(&self, p: Pt) -> bool {
        p[0] >= self.reach[0] && p[0] <= self.reach[2] && p[1] >= self.reach[1] && p[1] <= self.reach[3]
    }

    /// True when the segment `a b`, both ends within the shape's reach, properly crosses one of its ring edges.
    /// With bands only the edges at the heights the segment spans are read, which are the only ones it can
    /// cross.
    fn crossed(&self, a: Pt, b: Pt) -> bool {
        let edge = |ri: u32, j: u32| -> Option<(Pt, Pt)> {
            let r = self.rings.get(ri as usize)?;
            Some((*r.get(j as usize)?, *r.get((j as usize + 1) % r.len())?))
        };
        match &self.rows {
            Some(rows) => (rows.band(a[1].min(b[1]))..=rows.band(a[1].max(b[1])))
                .any(|k| rows.band_edges(k).iter().any(|&(ri, j)| edge(ri, j).is_some_and(|(p, q)| crosses_properly(a, b, p, q)))),
            None => self.rings.iter().any(|r| {
                let n = r.len();
                (0..n).any(|i| matches!((r.get(i), r.get((i + 1) % n)), (Some(&p), Some(&q)) if crosses_properly(a, b, p, q)))
            }),
        }
    }

    /// [`in_shape`] with the bounds checked first.
    fn holds(&self, p: Pt) -> bool {
        self.reaches(p)
            && match &self.rows {
                Some(rows) => rows.in_shape(&self.rings, p),
                None => in_shape(&self.rings, p),
            }
    }
}

/// True when the edge `a b` crosses the ray from `p` toward +x.
fn crosses_ray(a: Pt, b: Pt, p: Pt) -> bool {
    (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
}

fn inside_ring(ring: &[Pt], p: Pt) -> bool {
    let n = ring.len();
    let mut inside = false;
    for i in 0..n {
        let (Some(&a), Some(&b)) = (ring.get(i), ring.get((i + 1) % n)) else {
            continue;
        };
        if crosses_ray(a, b, p) {
            inside = !inside;
        }
    }
    inside
}

fn near_ring(ring: &[Pt], p: Pt, tol: f64) -> bool {
    let n = ring.len();
    (0..n).any(|i| match (ring.get(i), ring.get((i + 1) % n)) {
        (Some(&a), Some(&b)) => dist(p, closest_on_segment(p, a, b)) <= tol,
        _ => false,
    })
}

/// A point inside a shape (contour and not in a hole), or within the edge tolerance of one.
fn in_shape(rings: &[Vec<Pt>], p: Pt) -> bool {
    let Some(contour) = rings.first() else {
        return false;
    };
    if rings.iter().any(|r| near_ring(r, p, EDGE_TOL)) {
        return true;
    }
    inside_ring(contour, p) && !rings.iter().skip(1).any(|h| inside_ring(h, p))
}

/// True when one shape of `shapes` contains the whole segment.
fn contains_segment(shapes: &[Area], a: Pt, b: Pt) -> bool {
    shapes
        .iter()
        .any(|area| area.holds(a) && area.holds(b) && !area.crossed(a, b))
}

// ------------------------------------------------------------------ boundary

struct Ring {
    pts: Vec<Pt>,
    /// Distance along the ring to each point; one longer than `pts`, the last is the length.
    cum: Vec<f64>,
    bbox: [f64; 4],
}

#[derive(Clone, Copy, Debug)]
struct Hit {
    ring: usize,
    line: usize,
    point: Pt,
    dist: f64,
    keep: bool,
}

struct Boundary {
    rings: Vec<Ring>,
}

struct TravelPoint {
    point: Pt,
    keep: bool,
}

impl Boundary {
    /// Rings of the region, each turned so the region lies to its left.
    fn new(region: &Shapes) -> Self {
        let shapes: Vec<Area> = region.iter().map(|s| Area::new(s)).collect();
        let mut rings = Vec::new();
        for rs in &shapes {
            for r in &rs.rings {
                let mut pts = r.clone();
                if pts.len() < 3 {
                    continue;
                }
                // Turn the ring so the region is on its left.
                let n = pts.len();
                let (mut best, mut at) = (0.0, 0);
                for i in 0..n {
                    if let (Some(&a), Some(&b)) = (pts.get(i), pts.get((i + 1) % n)) {
                        let d = dist(a, b);
                        if d > best {
                            best = d;
                            at = i;
                        }
                    }
                }
                if let (Some(&a), Some(&b)) = (pts.get(at), pts.get((at + 1) % n)) {
                    let (mx, my) = (f64::midpoint(a[0], b[0]), f64::midpoint(a[1], b[1]));
                    let (dx, dy) = ((b[0] - a[0]) / best.max(1e-9), (b[1] - a[1]) / best.max(1e-9));
                    let left = [mx - dy * 0.01, my + dx * 0.01];
                    if !shapes.iter().any(|s| s.holds(left)) {
                        pts.reverse();
                    }
                }
                let mut cum = vec![0.0];
                for i in 0..pts.len() {
                    let d = match (pts.get(i), pts.get((i + 1) % pts.len())) {
                        (Some(&a), Some(&b)) => dist(a, b),
                        _ => 0.0,
                    };
                    cum.push(cum.last().copied().unwrap_or(0.0) + d);
                }
                let bbox = pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                    [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
                });
                rings.push(Ring { pts, cum, bbox });
            }
        }
        Self { rings }
    }

    fn len(&self, ring: usize) -> f64 {
        self.rings
            .get(ring)
            .and_then(|r| r.cum.last().copied())
            .unwrap_or(0.0)
    }

    /// Every crossing of the segment with a ring, in no order.
    fn intersections(&self, a: Pt, b: Pt) -> Vec<Hit> {
        let (lo, hi) = ([a[0].min(b[0]), a[1].min(b[1])], [a[0].max(b[0]), a[1].max(b[1])]);
        let mut out = Vec::new();
        for (ri, r) in self.rings.iter().enumerate() {
            if r.bbox[0] > hi[0] || r.bbox[2] < lo[0] || r.bbox[1] > hi[1] || r.bbox[3] < lo[1] {
                continue;
            }
            let n = r.pts.len();
            for i in 0..n {
                let (Some(&p), Some(&q)) = (r.pts.get(i), r.pts.get((i + 1) % n)) else {
                    continue;
                };
                if crosses_properly(a, b, p, q) {
                    let (d3, d4) = (cross(p, q, a), cross(p, q, b));
                    let t = d3 / (d3 - d4);
                    let point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                    let along = r.cum.get(i).copied().unwrap_or(0.0) + dist(p, point);
                    out.push(Hit {
                        ring: ri,
                        line: i,
                        point,
                        dist: along,
                        keep: false,
                    });
                }
            }
        }
        out
    }

    /// Ring segments within `radius` of `p`, nearest first, with the closest point on each.
    fn closest_lines(&self, p: Pt, radius: f64) -> Vec<Hit> {
        let mut out: Vec<(f64, Hit)> = Vec::new();
        for (ri, r) in self.rings.iter().enumerate() {
            if p[0] < r.bbox[0] - radius
                || p[0] > r.bbox[2] + radius
                || p[1] < r.bbox[1] - radius
                || p[1] > r.bbox[3] + radius
            {
                continue;
            }
            let n = r.pts.len();
            for i in 0..n {
                let (Some(&a), Some(&b)) = (r.pts.get(i), r.pts.get((i + 1) % n)) else {
                    continue;
                };
                let c = closest_on_segment(p, a, b);
                let d = dist(p, c);
                if d <= radius {
                    out.push((
                        d,
                        Hit {
                            ring: ri,
                            line: i,
                            point: c,
                            dist: r.cum.get(i).copied().unwrap_or(0.0) + dist(a, c),
                            keep: true,
                        },
                    ));
                }
            }
        }
        crate::sorting::sort_by(&mut out, |x, y| {
            x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        out.into_iter().map(|(_, h)| h).collect()
    }

    fn vertex(&self, ring: usize, i: usize) -> Pt {
        self.rings
            .get(ring)
            .and_then(|r| r.pts.get(i % r.pts.len().max(1)))
            .copied()
            .unwrap_or([0.0, 0.0])
    }

    /// Inward (left) unit normal at vertex `i`, from the neighbors that differ from it.
    fn normal_at(&self, ring: usize, i: usize) -> Pt {
        let Some(r) = self.rings.get(ring) else {
            return [0.0, 0.0];
        };
        let n = r.pts.len();
        let mid = self.vertex(ring, i);
        let mut left = self.vertex(ring, (i + n - 1) % n);
        let mut k = 1;
        while dist(left, mid) < 1e-9 && k < n {
            k += 1;
            left = self.vertex(ring, (i + n - k) % n);
        }
        let mut right = self.vertex(ring, (i + 1) % n);
        k = 1;
        while dist(right, mid) < 1e-9 && k < n {
            k += 1;
            right = self.vertex(ring, (i + k) % n);
        }
        normal3(left, mid, right)
    }

    fn offset_vertex(&self, ring: usize, i: usize) -> Pt {
        let (v, nrm) = (self.vertex(ring, i), self.normal_at(ring, i));
        [v[0] + nrm[0] * EPS, v[1] + nrm[1] * EPS]
    }

    /// A point on the ring, moved `EPS` inward, using the segment's neighbors for the direction.
    fn offset_middle(&self, ring: usize, line: usize, at: Pt) -> Pt {
        let Some(r) = self.rings.get(ring) else { return at };
        let n = r.pts.len();
        let (a, b) = (self.vertex(ring, line), self.vertex(ring, (line + 1) % n));
        let nrm = normal3(a, at, b);
        [at[0] + nrm[0] * EPS, at[1] + nrm[1] * EPS]
    }

    /// True when the segment crosses no ring.
    fn clear(&self, a: Pt, b: Pt) -> bool {
        self.intersections(a, b).is_empty()
    }
}

/// Normalized sum of the left normals of left-to-middle and middle-to-right.
fn normal3(left: Pt, mid: Pt, right: Pt) -> Pt {
    let perp = |a: Pt, b: Pt| {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = dx.m_hypot(dy).max(1e-12);
        [-dy / l, dx / l]
    };
    let (p, q) = (perp(left, mid), perp(mid, right));
    let s = [p[0] + q[0], p[1] + q[1]];
    let l = s[0].m_hypot(s[1]);
    if l < 1e-9 { p } else { [s[0] / l, s[1] / l] }
}

/// Routes `start` to `end` along the boundary. Returns the points and how many times the
/// straight line crossed a ring.
fn route(b: &Boundary, start: Pt, end: Pt, spacing: f64) -> (Vec<TravelPoint>, usize) {
    let (mut s, mut e) = (start, end);
    let mut hits = b.intersections(s, e);
    let mut dir = [e[0] - s[0], e[1] - s[1]];
    if hits.is_empty() {
        // The boundary is pulled in, so a travel between points near it may touch nothing: use the closest ring points instead.
        let radius = 1.5 * spacing;
        let (cs, ce) = (b.closest_lines(s, radius), b.closest_lines(e, radius));
        if !(cs.is_empty() && ce.is_empty()) {
            let ns = cs.first().map_or(s, |h| h.point);
            let ne = ce.first().map_or(e, |h| h.point);
            dir = [ne[0] - ns[0], ne[1] - ns[1]];
            let l = dir[0].m_hypot(dir[1]).max(1e-12);
            let u = [dir[0] / l, dir[1] / l];
            let (ns, ne) = (
                [ns[0] - u[0] * EPS, ns[1] - u[1] * EPS],
                [ne[0] + u[0] * EPS, ne[1] + u[1] * EPS],
            );
            let again = b.intersections(ns, ne);
            if !again.is_empty() {
                s = ns;
                e = ne;
                hits = again;
            }
        }
    }
    crate::sorting::sort_by(&mut hits, |x, y| {
        let d = |h: &Hit| (h.point[0] - s[0]) * dir[0] + (h.point[1] - s[1]) * dir[1];
        d(x).partial_cmp(&d(y)).unwrap_or(std::cmp::Ordering::Equal)
    });
    let hits = extend_for_closest_lines(b, &hits, s, e, 2.0 * spacing);
    let mut out = vec![TravelPoint {
        point: s,
        keep: false,
    }];
    let mut i = 0;
    while let Some(first) = hits.get(i) {
        let ring = first.ring;
        let n = b.rings.get(ring).map_or(0, |r| r.pts.len());
        out.push(TravelPoint {
            point: b.offset_middle(ring, first.line, first.point),
            keep: first.keep,
        });
        // The farthest later crossing of the same ring.
        let second = hits
            .iter()
            .enumerate()
            .skip(i + 1)
            .filter(|(_, h)| h.ring == ring)
            .map(|(j, h)| (j, *h))
            .next_back();
        if let Some((j, second)) = second {
            let len = b.len(ring);
            let forward = forward_is_shorter(b, first, &second, len);
            if forward {
                let mut line = first.line;
                while line != second.line {
                    let next = (line + 1) % n;
                    out.push(TravelPoint {
                        point: b.offset_vertex(ring, next),
                        keep: false,
                    });
                    line = next;
                }
            } else {
                let mut line = first.line;
                while line != second.line {
                    out.push(TravelPoint {
                        point: b.offset_vertex(ring, line),
                        keep: false,
                    });
                    line = if line == 0 { n - 1 } else { line - 1 };
                }
            }
            out.push(TravelPoint {
                point: b.offset_middle(ring, second.line, second.point),
                keep: second.keep,
            });
            i = j;
        }
        i += 1;
    }
    out.push(TravelPoint {
        point: e,
        keep: false,
    });
    let count = hits.len();
    if count > 0 {
        out = straighten(b, &out);
    }
    (out, count)
}

/// The ring distance from the first to the second crossing is shorter going forward than back.
fn forward_is_shorter(b: &Boundary, first: &Hit, second: &Hit, len: f64) -> bool {
    let (mut d1, mut d2) = (first.dist, second.dist);
    let reversed = d1 > d2;
    if reversed {
        std::mem::swap(&mut d1, &mut d2);
    }
    let (mut fwd, mut back) = (d2 - d1, d1 + len - d2);
    if reversed {
        std::mem::swap(&mut fwd, &mut back);
    }
    let n = b.rings.get(first.ring).map_or(1, |r| r.pts.len().max(1));
    fwd -= dist(first.point, b.vertex(first.ring, first.line));
    back -= dist(b.vertex(first.ring, (first.line + 1) % n), first.point);
    fwd -= dist(b.vertex(second.ring, (second.line + 1) % n), second.point);
    back -= dist(second.point, b.vertex(second.ring, second.line));
    fwd < back
}

/// Adds crossings at the ring points closest to the ends of the travel, since walls lie outside the pulled-in boundary.
fn extend_for_closest_lines(b: &Boundary, hits: &[Hit], start: Pt, end: Pt, radius: f64) -> Vec<Hit> {
    let (sl, el) = (b.closest_lines(start, radius), b.closest_lines(end, radius));
    if !sl.is_empty() && !el.is_empty() {
        // Both ends close to one ring: the whole detour can follow it.
        for ce in &el {
            if let Some(cs) = sl.iter().find(|c| c.ring == ce.ring) {
                return vec![*cs, *ce];
            }
        }
    }
    let closer = |lines: &[Hit], hit: &Hit, to: Pt| -> Option<usize> {
        let old = dist(to, hit.point).m_powi(2);
        lines
            .iter()
            .position(|c| c.ring == hit.ring && old <= radius * radius && dist(to, c.point).m_powi(2) < old)
    };
    let with_same_ring = |lines: &[Hit], hits: &mut dyn Iterator<Item = &Hit>| -> Option<Hit> {
        for h in hits {
            if let Some(c) = lines.iter().find(|c| c.ring == h.ring) {
                return Some(*c);
            }
        }
        None
    };
    let mut out = hits.to_vec();
    if let (Some(first), false) = (out.first().copied(), sl.is_empty()) {
        if let Some(k) = closer(&sl, &first, start) {
            if let (Some(slot), Some(c)) = (out.first_mut(), sl.get(k)) {
                *slot = *c;
            }
        } else if let Some(c) = with_same_ring(&sl, &mut out.iter().rev()).or_else(|| sl.first().copied()) {
            out.insert(0, c);
        }
    }
    if let (Some(last), false) = (out.last().copied(), el.is_empty()) {
        if let Some(k) = closer(&el, &last, end) {
            if let (Some(slot), Some(c)) = (out.last_mut(), el.get(k)) {
                *slot = *c;
            }
        } else if let Some(c) = with_same_ring(&el, &mut out.iter()).or_else(|| el.first().copied()) {
            out.push(c);
        }
    }
    out
}

/// Straightens the route wherever skipping points crosses no ring.
fn straighten(b: &Boundary, travel: &[TravelPoint]) -> Vec<TravelPoint> {
    let mut out: Vec<TravelPoint> = Vec::with_capacity(travel.len());
    let Some(first) = travel.first() else { return out };
    out.push(TravelPoint {
        point: first.point,
        keep: first.keep,
    });
    let mut i = 1;
    while i < travel.len() {
        let Some(current) = out.last().map(|p| p.point) else {
            break;
        };
        let Some(mut next) = travel.get(i).map(|p| TravelPoint {
            point: p.point,
            keep: p.keep,
        }) else {
            break;
        };
        if !next.keep {
            let mut j = i + 1;
            while let Some(cand) = travel.get(j) {
                if cand.keep {
                    break;
                }
                if dist(cand.point, current) < 1e-9 || b.clear(current, cand.point) {
                    next = TravelPoint {
                        point: cand.point,
                        keep: cand.keep,
                    };
                    i = j;
                }
                j += 1;
            }
        }
        out.push(next);
        i += 1;
    }
    out
}

// -------------------------------------------------------------------- layout

/// A planned travel: the points to move through, the last being the destination, and whether
/// the whole route stays inside one internal region of the layer (no top or bottom surface, no wall).
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub route: Vec<Point>,
    pub internal: bool,
}

/// Travel planning for one layer.
pub struct Layout {
    boundary: Option<Boundary>,
    /// The slice pulled in by about half an outer wall: a travel inside one island of it needs no detour.
    inner: Vec<Area>,
    /// Internal regions: the slice without top and bottom surfaces.
    internal: Vec<Area>,
    spacing: f64,
    /// Whether `boundary` and `inner` were worked out, which only combing reads.
    combs: bool,
}

impl Layout {
    /// None when the layer kept no regions.
    pub fn from_layer(layer: &LayerPaths, cfg: &crate::config::PrintConfig) -> Option<Self> {
        Self::for_travels(layer, cfg, true)
    }

    /// [`Self::from_layer`] for travels planned with `comb` as given. Without combing a plan reads the
    /// internal regions only, so the boundary (a variable offset that measures the part's width at every
    /// point of the outline) and the inner area are not worked out.
    pub(crate) fn for_travels(
        layer: &LayerPaths,
        cfg: &crate::config::PrintConfig,
        comb: bool,
    ) -> Option<Self> {
        let areas = layer.areas.as_ref()?;
        if areas.slice.is_empty() {
            return None;
        }
        let spacing = cfg.flow_spacing();
        let internal =
            perimeters::difference(&perimeters::difference(&areas.slice, &areas.top), &areas.bottom);
        let internal = internal.iter().map(|s| Area::new(s)).collect();
        if !comb {
            return Some(Self {
                boundary: None,
                inner: Vec::new(),
                internal,
                spacing,
                combs: false,
            });
        }
        let s = crate::geom::mm(spacing);
        let outer_w = cfg.line_width;
        // The slice pulled in by 0.6, 0.5 or 0.45 of the outer wall width, the first that leaves something.
        let mut inner = Vec::new();
        for k in [0.6, 0.5, 0.45] {
            let o = perimeters::offset(&areas.slice, -crate::geom::mm(outer_w * k));
            if !o.is_empty() {
                inner = o;
                break;
            }
        }
        // The boundary: the slice pulled in by one and a half spacings (islands that would vanish keep a smaller inset),
        // without the top surfaces shrunk by 0.6 spacings.
        let boundary = crate::inner_offset::inner_offset(&areas.slice, 1.5 * spacing);
        let boundary = if areas.top.is_empty() {
            boundary
        } else {
            let shrunk = perimeters::offset(&areas.top, -scaled(s, 0.6));
            perimeters::difference(&boundary, &shrunk)
        };
        Some(Self {
            boundary: Some(Boundary::new(&boundary)),
            inner: inner.iter().map(|s| Area::new(s)).collect(),
            internal,
            spacing,
            combs: true,
        })
    }

    /// The route for a travel from `a` to `b`. With `comb` a travel that leaves the part's interior is routed
    /// along the boundary, unless that is more than `detour_limit` mm longer (0 for no limit).
    pub fn plan(&self, a: Point, b: Point, comb: bool, detour_limit: f64) -> Plan {
        debug_assert!(
            !comb || self.combs,
            "a layout made without combing was asked to comb"
        );
        let (pa, pb) = ([a.x_mm(), a.y_mm()], [b.x_mm(), b.y_mm()]);
        let mut pts: Vec<Pt> = vec![pb];
        if comb
            && !contains_segment(&self.inner, pa, pb)
            && let Some(bound) = self.boundary.as_ref().filter(|bd| !bd.rings.is_empty())
        {
            let (path, _) = route(bound, pa, pb, self.spacing);
            let mut routed: Vec<Pt> = path.iter().skip(1).map(|t| t.point).collect();
            if let Some(last) = routed.last_mut() {
                *last = pb;
            }
            let length: f64 = std::iter::once(pa)
                .chain(routed.iter().copied())
                .collect::<Vec<_>>()
                .windows(2)
                .map(|w| w.first().zip(w.get(1)).map_or(0.0, |(x, y)| dist(*x, *y)))
                .sum();
            if (detour_limit <= 0.0 || length - dist(pa, pb) <= detour_limit) && !routed.is_empty() {
                pts = routed;
            }
        }
        let mut from = pa;
        let internal = pts.iter().all(|&to| {
            let ok = contains_segment(&self.internal, from, to);
            from = to;
            ok
        });
        Plan {
            route: pts.iter().map(|p| Point::from_mm(p[0], p[1])).collect(),
            internal,
        }
    }
}

#[allow(clippy::cast_possible_truncation, reason = "a fraction of a spacing")]
fn scaled(units: i32, k: f64) -> i32 {
    (f64::from(units) * k).round() as i32
}

/// True for the features a travel to which ends on a wall.
pub fn is_wall(f: Feature) -> bool {
    matches!(f, Feature::OuterWall | Feature::InnerWall | Feature::OverhangWall)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::LayerAreas;
    use i_overlay::i_float::int::point::IntPoint;

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<IntPoint<i32>> {
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            .iter()
            .map(|&(x, y)| IntPoint::new(crate::geom::mm(x), crate::geom::mm(y)))
            .collect()
    }

    /// A 40 mm square with a 10 mm hole in the middle, no top or bottom surfaces.
    fn layout() -> Layout {
        let mut hole = square(15.0, 15.0, 25.0, 25.0);
        hole.reverse();
        let slice: Shapes = vec![vec![square(0.0, 0.0, 40.0, 40.0), hole]];
        let areas = LayerAreas {
            slice,
            top: Vec::new(),
            bottom: Vec::new(),
            solid: Vec::new(),
        };
        let layer = LayerPaths {
            areas: Some(Box::new(areas)),
            ..LayerPaths::default()
        };
        let cfg = crate::config::PrintConfig {
            line_width: 0.42,
            ..crate::config::PrintConfig::default()
        };
        Layout::from_layer(&layer, &cfg).unwrap()
    }

    #[test]
    fn a_travel_beside_the_hole_is_left_alone() {
        let l = layout();
        let p = l.plan(Point::from_mm(5.0, 5.0), Point::from_mm(35.0, 5.0), true, 0.0);
        assert_eq!(p.route.len(), 1);
        assert!(p.internal);
    }

    #[test]
    fn a_travel_across_the_hole_goes_around_it() {
        let l = layout();
        let (a, b) = (Point::from_mm(5.0, 20.0), Point::from_mm(35.0, 20.0));
        let straight = l.plan(a, b, false, 0.0);
        assert_eq!(straight.route, vec![b]);
        assert!(!straight.internal);
        let around = l.plan(a, b, true, 0.0);
        assert!(around.route.len() >= 2, "{around:?}");
        assert_eq!(around.route.last(), Some(&b));
        assert!(around.internal, "the detour stays inside");
        let length: f64 = std::iter::once(a)
            .chain(around.route.iter().copied())
            .collect::<Vec<_>>()
            .windows(2)
            .map(|w| w[0].dist_mm(w[1]))
            .sum();
        assert!(
            length > 30.0 && length < 70.0,
            "{length} {:?}",
            around
                .route
                .iter()
                .map(|p| (p.x_mm(), p.y_mm()))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_detour_limit_falls_back_to_the_straight_line() {
        let l = layout();
        let p = l.plan(Point::from_mm(5.0, 20.0), Point::from_mm(35.0, 20.0), true, 1.0);
        assert_eq!(p.route.len(), 1);
    }

    #[test]
    fn a_travel_over_a_top_surface_is_not_internal() {
        let slice: Shapes = vec![vec![square(0.0, 0.0, 40.0, 40.0)]];
        let top: Shapes = vec![vec![square(0.0, 0.0, 40.0, 20.0)]];
        let areas = LayerAreas {
            slice,
            top,
            bottom: Vec::new(),
            solid: Vec::new(),
        };
        let layer = LayerPaths {
            areas: Some(Box::new(areas)),
            ..LayerPaths::default()
        };
        let l = Layout::from_layer(&layer, &crate::config::PrintConfig::default()).unwrap();
        assert!(
            l.plan(Point::from_mm(5.0, 30.0), Point::from_mm(35.0, 30.0), false, 0.0)
                .internal
        );
        assert!(
            !l.plan(Point::from_mm(5.0, 10.0), Point::from_mm(35.0, 10.0), false, 0.0)
                .internal
        );
    }
}
