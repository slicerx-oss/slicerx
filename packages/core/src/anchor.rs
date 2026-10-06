// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Connected infill: infill lines that end on the boundary of their region are joined through the
//! boundary, so the nozzle does not lift and retract between them. `sparse_infill_anchor_max` is the
//! longest piece of boundary that joins two lines; `sparse_infill_anchor` is how much boundary a line
//! that cannot be joined still follows, as a hook that anchors its end.
//!
//! Our own implementation of what Orca's `Fill::connect_infill` (`Fill/FillBase.cpp`) does with
//! `create_boundary_infill_graph`: the line ends on each ring are sorted along it, the arcs between
//! neighboring ends are taken shortest first to join the two lines they lead to (when shorter than
//! `anchor_max`) or as hooks of at most `anchor` on both sides, and the ends left over join or hook along
//! their shorter neighbor arc. An arc that runs alongside another infill line is not followed.

use crate::edge::Edge;
use crate::fm::Fm as _;
use crate::geom::Point;
use crate::perimeters::Shapes;
use std::collections::HashMap;

/// Lengths in mm.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Params {
    /// Pitch of the infill lines (their width), mm.
    pub spacing: f64,
    /// Length of boundary a lone line end follows; 0 turns hooks off.
    pub anchor: f64,
    /// Longest boundary piece that joins two lines.
    pub anchor_max: f64,
}

/// One line end on a ring: Orca's `ContourIntersectionPoint`.
struct End {
    line: usize,
    ring: usize,
    pos: f64,
    next: usize,
    prev: usize,
    /// Length of the arc to `next` and `prev`.
    arc_next: f64,
    arc_prev: f64,
    /// Length of each arc not yet taken by a line or masked by another line.
    free_next: f64,
    free_prev: f64,
    trimmed_next: bool,
    trimmed_prev: bool,
    consumed: bool,
}

/// Lengths below this count as nothing, mm.
const EPS: f64 = 1e-4;

/// Arcs this close in length count as the same length when choosing which to take first, mm.
const TIE: f64 = 0.005;

/// A longest join under this means none, mm (Orca `FillParams::dont_connect`).
const NO_CONNECT: f64 = 0.05;

impl End {
    fn consume_next(&mut self) {
        self.free_next = 0.0;
        self.trimmed_next = true;
        self.consumed = true;
    }
    fn consume_prev(&mut self) {
        self.free_prev = 0.0;
        self.trimmed_prev = true;
        self.consumed = true;
    }
    fn trim_next(&mut self, len: f64) {
        if len < self.free_next {
            self.free_next = len;
            self.trimmed_next = true;
        }
    }
    fn trim_prev(&mut self, len: f64) {
        if len < self.free_prev {
            self.free_prev = len;
            self.trimmed_prev = true;
        }
    }
    fn could_take_next(&self) -> bool {
        !self.consumed && self.free_next > EPS
    }
    fn could_take_prev(&self) -> bool {
        !self.consumed && self.free_prev > EPS
    }
}

/// A whole arc to the next (or previous) end could be followed.
fn could_connect(ends: &[End], i: usize, next: bool) -> bool {
    let Some(e) = ends.get(i) else { return false };
    let j = if next { e.next } else { e.prev };
    let Some(o) = ends.get(j) else { return false };
    if next {
        !e.consumed && j != i && !o.consumed && !e.trimmed_next && !o.trimmed_prev
    } else {
        !e.consumed && j != i && !o.consumed && !e.trimmed_prev && !o.trimmed_next
    }
}

/// How close to a ring a line end must be to be on it, mm: ends of trimmed scanline spans sit a
/// little inside.
const ON_RING: f64 = 0.4;

type Seg2 = ([f64; 2], [f64; 2]);

fn root(parent: &mut [usize], mut i: usize) -> usize {
    while let Some(&p) = parent.get(i) {
        if p == i {
            break;
        }
        i = p;
    }
    i
}

/// Joins the infill `lines` (polylines whose two ends lie on the boundary of `region`, as far as they do).
pub(crate) fn connect(lines: Vec<Vec<Point>>, region: &Shapes, p: Params) -> Vec<Vec<Point>> {
    // A limit under `NO_CONNECT` means the lines stay apart, without joins or hooks (Orca `dont_connect`).
    if p.anchor_max < NO_CONNECT || (lines.len() < 2 && p.anchor <= 0.0) {
        return lines;
    }
    let edge = Edge::new(region);
    let mut lines: Vec<Vec<Point>> = lines;
    let mut ends: Vec<End> = Vec::new();
    for (li, l) in lines.iter().enumerate() {
        for pt in [l.first(), l.last()].into_iter().flatten() {
            if let Some((ring, pos)) = edge.locate(*pt, ON_RING) {
                ends.push(End {
                    line: li,
                    ring,
                    pos,
                    next: ends.len(),
                    prev: ends.len(),
                    arc_next: 0.0,
                    arc_prev: 0.0,
                    free_next: 0.0,
                    free_prev: 0.0,
                    trimmed_next: false,
                    trimmed_prev: false,
                    consumed: false,
                });
            }
        }
    }
    // Sort the ends along each ring and link neighbors.
    let mut by_ring: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, e) in ends.iter().enumerate() {
        by_ring.entry(e.ring).or_default().push(i);
    }
    let mut ring_ids: Vec<usize> = by_ring.keys().copied().collect();
    ring_ids.sort_unstable();
    for r in ring_ids {
        let Some(mut ids) = by_ring.remove(&r) else {
            continue;
        };
        crate::sorting::sort_by(&mut ids, |&a, &b| {
            let (pa, pb) = (
                ends.get(a).map_or(0.0, |e| e.pos),
                ends.get(b).map_or(0.0, |e| e.pos),
            );
            pa.total_cmp(&pb).then(a.cmp(&b))
        });
        let total = edge.ring_length(r);
        let m = ids.len();
        for (k, &i) in ids.iter().enumerate() {
            let (Some(&nx), Some(&pv)) = (ids.get((k + 1) % m), ids.get((k + m - 1) % m)) else {
                continue;
            };
            let pos = ends.get(i).map_or(0.0, |e| e.pos);
            let next_pos = ends.get(nx).map_or(0.0, |e| e.pos);
            let prev_pos = ends.get(pv).map_or(0.0, |e| e.pos);
            let (ln, lp) = if m == 1 {
                (total, total)
            } else {
                (
                    (next_pos - pos).rem_euclid(total),
                    (pos - prev_pos).rem_euclid(total),
                )
            };
            if let Some(e) = ends.get_mut(i) {
                e.next = nx;
                e.prev = pv;
                e.arc_next = ln;
                e.arc_prev = lp;
                e.free_next = ln;
                e.free_prev = lp;
            }
        }
    }
    // An arc that runs alongside an infill line is not followed: the line is there already.
    block_arcs(&mut ends, &lines, &edge, p);

    let mut parent: Vec<usize> = (0..lines.len()).collect();
    let half = 0.5 * p.spacing;
    // Arcs, shortest first. Arcs within `TIE` of each other count as one length and are taken in order along
    // their ring: a regular pattern gives many arcs of one length, and the order among them decides which
    // loops close and so how many strokes are left. Rounding noise used to decide it (a grid on the block
    // left four strokes); Orca's integer lengths decide it there, by luck as often as not.
    let tier = |l: f64| -> i64 {
        #[allow(clippy::cast_possible_truncation, reason = "arc length in steps of TIE, far inside i64")]
        {
            (l / TIE).round() as i64
        }
    };
    let mut arcs: Vec<(f64, usize)> = (0..ends.len())
        .filter(|&i| ends.get(i).is_some_and(|e| e.next != i) && could_connect(&ends, i, true))
        .map(|i| (ends.get(i).map_or(0.0, |e| e.arc_next), i))
        .collect();
    crate::sorting::sort_by(&mut arcs, |a, b| {
        let at = |i: usize| ends.get(i).map_or((0, 0.0), |e| (e.ring, e.pos));
        let (ra, pa) = at(a.1);
        let (rb, pb) = at(b.1);
        tier(a.0)
            .cmp(&tier(b.0))
            .then(ra.cmp(&rb))
            .then(pa.total_cmp(&pb))
            .then(a.1.cmp(&b.1))
    });
    for (len, i) in arcs {
        let Some(nx) = ends.get(i).map(|e| e.next) else {
            continue;
        };
        if ends.get(i).is_none_or(|e| e.consumed) || ends.get(nx).is_none_or(|e| e.consumed) {
            continue;
        }
        let (Some(a), Some(b)) = (ends.get(i), ends.get(nx)) else {
            continue;
        };
        let (ring, pos_a, pos_b, line_a, line_b) = (a.ring, a.pos, b.pos, a.line, b.line);
        let (ra, rb) = (root(&mut parent, line_a), root(&mut parent, line_b));
        if ra == rb {
            continue;
        }
        if len < p.anchor_max {
            join(
                &mut lines,
                &mut parent,
                &edge,
                (ra, rb),
                (ring, pos_a, pos_b),
                true,
            );
            if let Some(e) = ends.get_mut(i) {
                e.consume_next();
            }
            if let Some(e) = ends.get_mut(nx) {
                e.consume_prev();
            }
        } else if p.anchor > EPS {
            take_limited(
                &mut lines,
                &edge,
                &mut ends,
                &parent,
                (i, nx, false),
                p.anchor,
                half,
            );
            take_limited(
                &mut lines,
                &edge,
                &mut ends,
                &parent,
                (nx, i, true),
                p.anchor,
                half,
            );
        }
    }
    // The ends left over join along their shorter neighbor arc or follow it as a hook.
    for i in 0..ends.len() {
        let Some(e) = ends.get(i) else { continue };
        if e.consumed {
            continue;
        }
        let (ring, pos, line, prev, next) = (e.ring, e.pos, e.line, e.prev, e.next);
        let lp = if could_connect(&ends, i, false) {
            e.arc_prev
        } else {
            f64::INFINITY
        };
        let ln = if could_connect(&ends, i, true) {
            e.arc_next
        } else {
            f64::INFINITY
        };
        let (fp, fn_) = (e.free_prev, e.free_next);
        let mut connected = false;
        // The shorter side first.
        let sides = if lp <= ln {
            [(true, lp), (false, ln)]
        } else {
            [(false, ln), (true, lp)]
        };
        for (back, l) in sides {
            if !l.is_finite() || l > p.anchor_max {
                break;
            }
            let other = if back { prev } else { next };
            let Some(o) = ends.get(other) else { continue };
            let (ro, rl) = (root(&mut parent, o.line), root(&mut parent, line));
            if ro == rl {
                continue;
            }
            let opos = o.pos;
            join(&mut lines, &mut parent, &edge, (rl, ro), (ring, pos, opos), !back);
            // `take`: the arc between the two ends is used up.
            let (lo, hi) = if back { (other, i) } else { (i, other) };
            if let Some(e) = ends.get_mut(lo) {
                e.consume_next();
            }
            if let Some(e) = ends.get_mut(hi) {
                e.consume_prev();
            }
            connected = true;
            break;
        }
        if !connected && p.anchor > EPS {
            // The side with more contour left, which leaves room for another hook on the other.
            let l = fp.max(fn_);
            if l > EPS {
                if fp > fn_ {
                    take_limited(
                        &mut lines,
                        &edge,
                        &mut ends,
                        &parent,
                        (i, prev, true),
                        p.anchor,
                        half,
                    );
                } else {
                    take_limited(
                        &mut lines,
                        &edge,
                        &mut ends,
                        &parent,
                        (i, next, false),
                        p.anchor,
                        half,
                    );
                }
            }
        }
    }
    let mut out = Vec::new();
    for (i, l) in lines.into_iter().enumerate() {
        if parent.get(i) == Some(&i) && !l.is_empty() {
            out.push(l);
        }
    }
    out
}

/// Joins the polylines rooted at `first` and `second` along ring `ring` from `pos_a` (an open end of the
/// first) to `pos_b` (an open end of the second), going forward or back.
fn join(
    lines: &mut [Vec<Point>],
    parent: &mut [usize],
    edge: &Edge,
    roots: (usize, usize),
    at: (usize, f64, f64),
    forward: bool,
) {
    let (first, second) = roots;
    let (ring, pos_a, pos_b) = at;
    let (Some(start), Some(finish)) = (edge.point_at(ring, pos_a), edge.point_at(ring, pos_b)) else {
        return;
    };
    let a = lines.get_mut(first).map(std::mem::take).unwrap_or_default();
    let b = lines.get_mut(second).map(std::mem::take).unwrap_or_default();
    // Each polyline's end that touches the ring is the one nearest the ring point.
    let near = |l: &[Point], p: Point| -> bool {
        l.first()
            .zip(l.last())
            .is_some_and(|(f, e)| f.dist_mm(p) < e.dist_mm(p))
    };
    let mut a = a;
    if near(&a, start) {
        a.reverse();
    }
    let mut b = b;
    if !near(&b, finish) {
        b.reverse();
    }
    let mut via = edge.walk(ring, pos_a, pos_b, forward);
    // The walk ends with the point at `pos_b`, which the second polyline starts with.
    via.pop();
    a.extend(via);
    a.extend(b);
    if let Some(l) = lines.get_mut(first) {
        *l = a;
    }
    if let Some(p) = parent.get_mut(second) {
        *p = first;
    }
}

/// Orca's `take_limited`: the end `start` of its line follows the ring (`cw`: against its direction) up to
/// `max_len`, through `end` at most, never closer than half a line to the next end and never over contour
/// already used (`free`). `at` is (start, end, cw).
fn take_limited(
    lines: &mut [Vec<Point>],
    edge: &Edge,
    ends: &mut [End],
    parent: &[usize],
    at: (usize, usize, bool),
    max_len: f64,
    half: f64,
) {
    let (start, end, cw) = at;
    let Some(e) = ends.get(start) else { return };
    if !(if cw {
        e.could_take_prev()
    } else {
        e.could_take_next()
    }) {
        return;
    }
    let (ring, line, mut from) = (e.ring, e.line, e.pos);
    let total = edge.ring_length(ring);
    let mut go = max_len;
    let mut piece: Vec<Point> = Vec::new();
    if let Some(e) = ends.get_mut(start) {
        e.consumed = true;
    }
    if start == end {
        let free = ends
            .get(start)
            .map_or(0.0, |e| if cw { e.free_prev } else { e.free_next });
        go = go.min(total - half).min(free).max(0.0);
        if let Some(e) = ends.get_mut(start) {
            e.consume_prev();
            e.consume_next();
        }
        if go > EPS {
            piece = edge.walk(ring, from, if cw { from - go } else { from + go }, !cw);
        }
    } else {
        let mut cp = start;
        let mut guard = 0;
        while cp != end && guard < ends.len() + 2 {
            guard += 1;
            let Some(e) = ends.get(cp) else { break };
            let (nx, l, free) = if cw {
                (e.prev, e.arc_prev, e.free_prev)
            } else {
                (e.next, e.arc_next, e.free_next)
            };
            go = go.min(free);
            go = go.min(l - half).max(0.0);
            if let Some(e) = ends.get_mut(cp) {
                if cw {
                    e.consume_prev();
                } else {
                    e.consume_next();
                }
            }
            if l >= go {
                if go > EPS {
                    if let Some(n) = ends.get_mut(nx) {
                        if cw {
                            n.trim_next(l - go);
                        } else {
                            n.trim_prev(l - go);
                        }
                    }
                    piece.extend(edge.walk(ring, from, if cw { from - go } else { from + go }, !cw));
                }
                break;
            }
            if let Some(n) = ends.get_mut(nx) {
                if cw {
                    n.trim_next(0.0);
                } else {
                    n.trim_prev(0.0);
                }
            }
            let to = ends.get(nx).map_or(from, |n| n.pos);
            piece.extend(edge.walk(ring, from, to, !cw));
            from = to;
            go -= l;
            cp = nx;
        }
    }
    if piece.is_empty() {
        return;
    }
    let mut r = line;
    while let Some(&pr) = parent.get(r) {
        if pr == r {
            break;
        }
        r = pr;
    }
    let Some(start_pt) = edge.point_at(ring, ends.get(start).map_or(0.0, |e| e.pos)) else {
        return;
    };
    if let Some(l) = lines.get_mut(r) {
        let at_front = l
            .first()
            .zip(l.last())
            .is_some_and(|(f, e)| f.dist_mm(start_pt) <= e.dist_mm(start_pt));
        if at_front {
            l.reverse();
            l.extend(piece);
            l.reverse();
        } else {
            l.extend(piece);
        }
    }
}

/// Marks the arcs that run alongside an infill line as not to be followed.
fn block_arcs(ends: &mut [End], lines: &[Vec<Point>], edge: &Edge, p: Params) {
    let clip = 1.7 * p.spacing;
    let reach = 0.8 * p.spacing;
    // The infill lines without their ends, in a grid.
    let cell = |v: f64| -> i32 {
        #[allow(clippy::cast_possible_truncation, reason = "cell index of a plate coordinate")]
        {
            (v / 4.0).floor() as i32
        }
    };
    let mut grid: HashMap<(i32, i32), Vec<Seg2>> = HashMap::new();
    for l in lines {
        let total: f64 = l
            .windows(2)
            .map(|w| w.first().zip(w.get(1)).map_or(0.0, |(a, b)| a.dist_mm(*b)))
            .sum();
        if total <= 2.0 * clip {
            continue;
        }
        let mut walked = 0.0;
        for w in l.windows(2) {
            let (Some(a), Some(b)) = (w.first(), w.get(1)) else {
                continue;
            };
            let len = a.dist_mm(*b);
            let (t0, t1) = (
                ((clip - walked) / len).clamp(0.0, 1.0),
                ((total - clip - walked) / len).clamp(0.0, 1.0),
            );
            walked += len;
            if t1 <= t0 {
                continue;
            }
            let lerp = |t: f64| {
                [
                    a.x_mm() + t * (b.x_mm() - a.x_mm()),
                    a.y_mm() + t * (b.y_mm() - a.y_mm()),
                ]
            };
            let (s, e) = (lerp(t0), lerp(t1));
            let (x0, x1) = (cell(s[0].min(e[0]) - reach), cell(s[0].max(e[0]) + reach));
            let (y0, y1) = (cell(s[1].min(e[1]) - reach), cell(s[1].max(e[1]) + reach));
            for cx in x0..=x1 {
                for cy in y0..=y1 {
                    grid.entry((cx, cy)).or_default().push((s, e));
                }
            }
        }
    }
    let near = |pt: [f64; 2]| -> bool {
        grid.get(&(cell(pt[0]), cell(pt[1]))).is_some_and(|segs| {
            segs.iter().any(|(a, b)| {
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let len2 = dx * dx + dy * dy;
                let t = if len2 > 0.0 {
                    (((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                (pt[0] - (a[0] + t * dx)).m_hypot(pt[1] - (a[1] + t * dy)) < reach
            })
        })
    };
    let step = (0.3 * p.spacing).max(0.05);
    for i in 0..ends.len() {
        let Some(e) = ends.get(i) else { continue };
        if e.next == i || e.trimmed_next {
            continue;
        }
        let (ring, pos, len) = (e.ring, e.pos, e.arc_next);
        // Sample the arc away from its two ends, where it meets the lines that lead to it, and find the
        // stretch that runs alongside a line: the free parts at either end stay available for hooks.
        let mut d = clip.min(len / 2.0);
        let (mut first, mut last) = (None, None);
        while d < len - clip.min(len / 2.0) {
            if let Some(pt) = edge.point_at(ring, pos + d)
                && near([pt.x_mm(), pt.y_mm()])
            {
                first.get_or_insert(d);
                last = Some(d);
            }
            d += step;
        }
        if let (Some(f), Some(l)) = (first, last) {
            let nx = ends.get(i).map_or(i, |e| e.next);
            if let Some(e) = ends.get_mut(i) {
                e.trim_next((f - reach).max(0.0));
                e.trimmed_next = true;
            }
            if let Some(e) = ends.get_mut(nx) {
                e.trim_prev((len - l - reach).max(0.0));
                e.trimmed_prev = true;
            }
        }
    }
}

/// The anchor length of a profile in mm (`infill_anchor`, older profiles `sparse_infill_anchor`): a number
/// of mm or a percent of the line spacing, 400 percent by default, never more than the maximum
/// (`Fill.cpp`, `params.anchor_length`).
pub(crate) fn anchor_length(cfg: &crate::config::PrintConfig, spacing_mm: f64) -> f64 {
    let own = ["infill_anchor", "sparse_infill_anchor"]
        .iter()
        .find_map(|k| cfg.raw.get(*k))
        .and_then(|v| crate::config::float_or_percent(v, spacing_mm))
        .unwrap_or(4.0 * spacing_mm);
    own.min(cfg.anchor_max_mm())
}
