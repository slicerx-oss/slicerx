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
    /// A lone end's hook may run on along a narrow tongue of the region to its tip (see `hook_reach`). Only for a
    /// region already pulled in half a line spacing, whose edge is where line centers go: along the edge of the
    /// raw area a longer hook would lie on the walls and on the vertical shells that border the area.
    pub tongues: bool,
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
        #[allow(
            clippy::cast_possible_truncation,
            reason = "arc length in steps of TIE, far inside i64"
        )]
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
                    let reach = hook_reach(&ends, &edge, (i, prev, false), p);
                    take_limited(
                        &mut lines,
                        &edge,
                        &mut ends,
                        &parent,
                        (i, prev, true),
                        reach,
                        half,
                    );
                } else {
                    let reach = hook_reach(&ends, &edge, (i, next, true), p);
                    take_limited(
                        &mut lines,
                        &edge,
                        &mut ends,
                        &parent,
                        (i, next, false),
                        reach,
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

/// How far a lone end's hook follows the ring from the end `at.0` toward its neighbor end `at.1` (`at.2`: forward,
/// toward the next end): the anchor length, except where the arc between the two ends runs out and back along a
/// tongue of the region (not a slot cut into it) that no line reaches, such as the start of the strip that capped walls leave between them on a
/// part that widens. There the hook runs on to the tongue's tip (half the arc), up to [`TONGUE_ANCHORS`] anchor
/// lengths and the longest join, and never shorter than the anchor length. Stopped at the anchor length (1.6 mm),
/// it left the last 2 mm of such a strip empty on every layer: a void up to 0.43 mm wide where a wedge with
/// 0.40 mm inner walls is 1.86 to 1.99 mm wide.
fn hook_reach(ends: &[End], edge: &Edge, at: (usize, usize, bool), p: Params) -> f64 {
    let (start, other, forward) = at;
    let (Some(s), Some(o)) = (ends.get(start), ends.get(other)) else {
        return p.anchor;
    };
    let arc = if forward { s.arc_next } else { s.arc_prev };
    let half_arc = 0.5 * arc;
    if !p.tongues || start == other || s.ring != o.ring || half_arc <= p.anchor {
        return p.anchor;
    }
    // A tongue: the two sides of the arc stay within two line spacings of each other, from the two ends out to
    // three quarters of the way to the tip. An arc round a whole region whose two ends happen to be close fails
    // this at once.
    let dir = if forward { 1.0 } else { -1.0 };
    let narrow = (0..4).all(|k| {
        let q = half_arc * 0.25 * f64::from(k);
        match (
            edge.point_at(s.ring, s.pos + dir * q),
            edge.point_at(o.ring, o.pos - dir * q),
        ) {
            (Some(a), Some(b)) => a.dist_mm(b) <= 2.0 * p.spacing,
            _ => false,
        }
    });
    // And the arc goes round the region, not round a slot cut into it: closed by the line between the two ends, it
    // turns the way the ring does (walked backward, the other way).
    let ring = edge.walk(s.ring, 0.0, edge.ring_length(s.ring) - EPS, true);
    let mut out_and_back = edge.walk(s.ring, s.pos, s.pos + dir * arc, forward);
    out_and_back.dedup();
    let turn = crate::geom::area2(&out_and_back).signum() * if forward { 1 } else { -1 };
    if narrow && turn != 0 && turn == crate::geom::area2(&ring).signum() {
        half_arc
            .min(TONGUE_ANCHORS * p.anchor)
            .min(p.anchor_max)
            .max(p.anchor)
    } else {
        p.anchor
    }
}

/// The longest hook into a tongue, in anchor lengths.
const TONGUE_ANCHORS: f64 = 5.0;

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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    const P: Params = Params {
        spacing: 0.4,
        anchor: 1.6,
        anchor_max: 20.0,
        tongues: true,
    };

    /// A region `len` by `width` mm from the origin, crossed by lines at x = `a` and x = `b`.
    fn strip(len: f64, width: f64, a: f64, b: f64) -> (Vec<Vec<Point>>, Shapes) {
        let p = |x: f64, y: f64| {
            let q = Point::from_mm(x, y);
            IntPoint::new(q.x, q.y)
        };
        let region = vec![vec![vec![p(0.0, 0.0), p(len, 0.0), p(len, width), p(0.0, width)]]];
        let cross = |x: f64| vec![Point::from_mm(x, 0.0), Point::from_mm(x, width)];
        (vec![cross(a), cross(b)], region)
    }

    /// How close to the narrow end (x = 0) the joined and hooked lines come, mm.
    fn reach(len: f64, width: f64, a: f64) -> f64 {
        let (lines, region) = strip(len, width, a, len - 1.0);
        connect(lines, &region, P)
            .iter()
            .flatten()
            .map(|q| q.x_mm())
            .fold(f64::INFINITY, f64::min)
    }

    /// A strip 0.2 mm wide whose only line is 4 mm from its tip: the hook runs to the tip instead of stopping
    /// 1.6 mm along.
    #[test]
    fn a_hook_into_a_tongue_runs_to_its_tip() {
        let x = reach(10.0, 0.2, 4.0);
        assert!(x < 0.15, "{x}");
    }

    /// The same lines in a part 3 mm wide: the lone end keeps a hook of the anchor length.
    #[test]
    fn a_hook_round_a_wide_end_keeps_the_anchor_length() {
        let x = reach(10.0, 3.0, 4.0);
        assert!((x - (4.0 - P.anchor)).abs() < 0.02, "{x}");
    }

    /// A tongue whose tip the anchor length already reaches: the hook is the one of the anchor length.
    #[test]
    fn a_short_tongue_keeps_the_anchor_length() {
        let (lines, region) = strip(10.0, 0.2, 1.0, 2.0);
        let out = connect(lines, &region, P);
        let hooked = out
            .iter()
            .flatten()
            .map(|q| q.x_mm())
            .fold(f64::INFINITY, f64::min);
        assert!(hooked < 0.01, "{hooked}");
        // Round the tip and 0.4 mm back along the other side (1.0 + 0.2 + 0.4 mm), from either side.
        let back = P.anchor - 1.2;
        let ends: Vec<Point> = out.iter().flat_map(|l| [l[0], l[l.len() - 1]]).collect();
        assert!(
            ends.iter().any(|q| [0.0, 0.2]
                .iter()
                .any(|y| q.dist_mm(Point::from_mm(back, *y)) < 0.02)),
            "{out:?}"
        );
    }

    /// A line across a corner of a 10 mm square: its two ends are close, but the long arc between them runs round
    /// the whole square, not along a tongue, so each end keeps a hook of the anchor length.
    #[test]
    fn ends_close_together_on_a_wide_region_keep_the_anchor_length() {
        let p = |x: f64, y: f64| {
            let q = Point::from_mm(x, y);
            IntPoint::new(q.x, q.y)
        };
        let region = vec![vec![vec![p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)]]];
        let line = vec![Point::from_mm(0.0, 0.3), Point::from_mm(0.3, 0.0)];
        let length = |l: &[Point]| l.windows(2).map(|w| w[0].dist_mm(w[1])).sum::<f64>();
        let before = length(&line);
        let total: f64 = connect(vec![line], &region, P).iter().map(|l| length(l)).sum();
        assert!(total - before <= 2.0 * P.anchor + 0.02, "{total}");
    }

    /// A slot 0.3 mm wide cut 14 mm into a region, with lines leaning away from both sides of its mouth: the arc
    /// between their ends runs round the slot, which is not region, so the hooks stay at the anchor length.
    #[test]
    fn a_hook_round_a_slot_keeps_the_anchor_length() {
        let p = |x: f64, y: f64| {
            let q = Point::from_mm(x, y);
            IntPoint::new(q.x, q.y)
        };
        let region = vec![vec![vec![
            p(-3.0, 0.0),
            p(0.85, 0.0),
            p(0.85, 14.0),
            p(1.15, 14.0),
            p(1.15, 0.0),
            p(10.0, 0.0),
            p(10.0, 16.0),
            p(-3.0, 16.0),
        ]]];
        let lines = vec![
            vec![Point::from_mm(0.65, 0.0), Point::from_mm(-2.5, 16.0)],
            vec![Point::from_mm(1.35, 0.0), Point::from_mm(8.0, 16.0)],
        ];
        let out = connect(lines, &region, P);
        // Up a side of the slot by at most the anchor length less the 0.2 mm to its mouth.
        let up = out
            .iter()
            .flatten()
            .filter(|q| (q.x_mm() - 0.85).abs() < 0.01 || (q.x_mm() - 1.15).abs() < 0.01)
            .map(|q| q.y_mm())
            .fold(0.0, f64::max);
        assert!(up < P.anchor - 0.2 + 0.02, "{up}: {out:?}");
    }

    /// The tongue of the first test on a region that was not pulled in (`tongues` off): the anchor length.
    #[test]
    fn without_tongues_a_hook_keeps_the_anchor_length() {
        let (lines, region) = strip(10.0, 0.2, 4.0, 9.0);
        let off = Params { tongues: false, ..P };
        let x = connect(lines, &region, off)
            .iter()
            .flatten()
            .map(|q| q.x_mm())
            .fold(f64::INFINITY, f64::min);
        assert!((x - (4.0 - P.anchor)).abs() < 0.02, "{x}");
    }

    /// A tongue longer than five anchor lengths: the hook stops at five.
    #[test]
    fn a_hook_into_a_long_tongue_stops_at_five_anchor_lengths() {
        let x = reach(20.0, 0.2, 12.0);
        assert!((x - (12.0 - TONGUE_ANCHORS * P.anchor)).abs() < 0.02, "{x}");
    }
}
