// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Monotonic fill for solid surfaces: parallel lines printed so that every line sits next to the
//! one printed before it, left to right, with no jumping back across a finished area.
//!
//! The scanline spans of a surface are grouped into monotonic regions: chains of spans on
//! neighboring lines where each span overlaps exactly one span on the next line and that one
//! overlaps only it. A region is printed as one zigzag, each turn joined to the next line along
//! the edge of the surface when the turn is short. Regions are ordered so every region is printed
//! after all regions on its left, taking the nearest start next, and a region continues into a
//! right neighbor without lifting when the gap is short. This follows the structure of Orca's
//! `FillRectilinear.cpp` (`generate_montonous_regions`, `polylines_from_paths`); the order of the
//! regions is chosen greedily instead of by Orca's ant colony search.

use crate::edge::Edge;
use crate::geom::Point;
#[cfg(test)]
use crate::infill::Dir;
use crate::infill::Iv;

#[derive(Clone, Copy)]
struct Seg {
    k: i32,
    t0: i64,
    t1: i64,
}

struct Region {
    /// Indices into the span list, one per line, left to right.
    segs: Vec<usize>,
    left: Vec<usize>,
    right: Vec<usize>,
}

fn overlaps(a: &Seg, b: &Seg) -> bool {
    a.t0 < b.t1 && b.t0 < a.t1
}

fn dist(a: Point, b: Point) -> f64 {
    a.dist_mm(b)
}

/// How a turn from the end of one line to the next is drawn: along `edge` when there is one (the
/// vertices of the wall between the two ends), else as a chord; refused when longer than `max` mm.
/// A `max` of zero or less refuses every turn.
#[derive(Clone, Copy)]
pub(crate) struct Links<'a> {
    pub edge: Option<&'a Edge>,
    pub max: f64,
    /// Turn along a chord when the edge has no ring near the two ends (the boundary of a surface cut
    /// out of a bigger region is not in `edge`).
    pub chord_fallback: bool,
}

impl Links<'_> {
    /// The points between `a` and `b` (not including them) when a turn is allowed.
    fn between(&self, a: Point, b: Point) -> Option<Vec<Point>> {
        if self.max <= 0.0 {
            return None;
        }
        let chord = || (dist(a, b) <= self.max).then(Vec::new);
        match self.edge {
            Some(e) => e
                .arc(a, b, self.max)
                .or_else(|| if self.chord_fallback { chord() } else { None }),
            None => chord(),
        }
    }
}

/// The spans grouped by line, with neighbor lookup.
struct Layout {
    segs: Vec<Seg>,
    /// Range of spans of each line: (k, first, end), sorted by k.
    lines: Vec<(i32, usize, usize)>,
}

impl Layout {
    fn new(spans: &[Iv]) -> Self {
        let segs: Vec<Seg> = spans
            .iter()
            .map(|s| Seg {
                k: s.k,
                t0: s.t0,
                t1: s.t1,
            })
            .collect();
        let mut lines: Vec<(i32, usize, usize)> = Vec::new();
        for (i, s) in segs.iter().enumerate() {
            match lines.last_mut() {
                Some(l) if l.0 == s.k => l.2 = i + 1,
                _ => lines.push((s.k, i, i + 1)),
            }
        }
        Self { segs, lines }
    }

    fn line_range(&self, k: i32) -> std::ops::Range<usize> {
        self.lines
            .binary_search_by_key(&k, |l| l.0)
            .ok()
            .and_then(|i| self.lines.get(i))
            .map_or(0..0, |l| l.1..l.2)
    }

    /// Where the line of span `i` runs out to at its `high` or low end: the end of the outer contour's span that
    /// holds it, or halfway to the next span of the same line when that one lies in the same outer span (the
    /// inner contour is pinched there; Orca puts a phony outer pair in the gap).
    fn reach_t(&self, outer: &[Iv], i: usize, high: bool) -> Option<i64> {
        let s = self.segs.get(i)?;
        let at = if high { s.t1 } else { s.t0 };
        let lo = outer.partition_point(|o| (o.k, o.t1) < (s.k, at));
        let o = outer
            .get(lo)
            .filter(|o| o.k == s.k && o.t0 <= s.t1 && at <= o.t1)?;
        let line = self.line_range(s.k);
        let mut end = if high { o.t1 } else { o.t0 };
        for j in line {
            if j == i {
                continue;
            }
            let Some(n) = self.segs.get(j) else { continue };
            if high && n.t0 >= s.t1 && n.t0 <= o.t1 {
                end = end.min(s.t1 + (n.t0 - s.t1) / 2);
            } else if !high && n.t1 <= s.t0 && n.t1 >= o.t0 {
                end = end.max(n.t1 + (s.t0 - n.t1) / 2);
            }
        }
        Some(end)
    }

    /// Spans on the next line (`step` 1) or the previous one (-1) that overlap span `i`.
    fn neighbors(&self, i: usize, step: i32) -> Vec<usize> {
        let Some(s) = self.segs.get(i) else {
            return Vec::new();
        };
        self.line_range(s.k + step)
            .filter(|&j| self.segs.get(j).is_some_and(|o| overlaps(s, o)))
            .collect()
    }
}

#[cfg(test)]
/// Polylines filling `spans` with monotonic lines. `links` says how far and along what a turn may go;
/// `spacing` is the line pitch in the units of `Iv::k`.
pub(crate) fn polylines(spans: &[Iv], dir: Dir, spacing: i64, links: Links) -> Vec<Vec<Point>> {
    polylines_with(spans, spacing, links, &|s, t| dir.point(s, t))
}

/// [`polylines`] for any frame: `to_point(s, t)` maps the line offset `k * spacing` and the
/// position along the line to a plate point.
pub(crate) fn polylines_with(
    spans: &[Iv],
    spacing: i64,
    links: Links,
    to_point: &dyn Fn(i64, i64) -> Point,
) -> Vec<Vec<Point>> {
    polylines_core(spans, &[], spacing, links, to_point)
}

/// Monotonic polylines over the lines of a surface pulled in by half a spacing (`spans`, where the turns
/// happen and lines are neighbors when the wall joins their ends, as Orca's
/// `connect_segment_intersections_by_contours` decides) and pulled in by 0.05 spacing (`outer`, where the
/// two ends of each path reach).
pub(crate) fn polylines_outer(
    spans: &[Iv],
    outer: &[Iv],
    spacing: i64,
    links: Links,
    to_point: &dyn Fn(i64, i64) -> Point,
) -> Vec<Vec<Point>> {
    polylines_core(spans, outer, spacing, links, to_point)
}

/// Where the ends of the lines meet the walls and which ends are neighbors along the wall.
struct Contour<'a> {
    lay: &'a Layout,
    edge: &'a Edge,
    spacing: i64,
    proper: bool,
    to_point: &'a dyn Fn(i64, i64) -> Point,
    /// Where the low and high end of each span lie on the wall, worked out on first use: every side of
    /// every end reads the ends of the lines around it.
    places: Vec<[std::cell::OnceCell<Option<crate::edge::Place>>; 2]>,
}

/// One way to leave a line end along the wall: the span the link reaches, how many wall segments away
/// it is (Orca's metric) and the wall vertices between.
struct Cand {
    segments: usize,
    len: f64,
    j: usize,
    via: Vec<Point>,
    /// Where the reached end lies on the wall; the wall vertices (`via`) are worked out for the chosen
    /// candidates only.
    at: crate::edge::Place,
}

/// What `connect_segment_intersections_by_contours` decides for one end and one direction along the wall:
/// the end of the same kind on the neighboring line nearest in wall segments (a horizontal link), or an
/// end of the other kind on this line when that is strictly nearer (a vertical link, past a notch).
struct Side {
    horizontal: Option<Cand>,
    vertical: Option<Cand>,
}

impl<'a> Contour<'a> {
    fn new(
        lay: &'a Layout,
        edge: &'a Edge,
        spacing: i64,
        proper: bool,
        to_point: &'a dyn Fn(i64, i64) -> Point,
    ) -> Self {
        let places = (0..lay.segs.len()).map(|_| Default::default()).collect();
        Self {
            lay,
            edge,
            spacing,
            proper,
            to_point,
            places,
        }
    }

    /// Where the `high` or low end of span `i` lies on the wall.
    fn place(&self, i: usize, high: bool) -> Option<crate::edge::Place> {
        let cell = self.places.get(i)?.get(usize::from(high))?;
        if let Some(v) = cell.get() {
            return *v;
        }
        let v = self.xy(i, high).and_then(|p| self.edge.place(p));
        let _ = cell.set(v);
        v
    }

    fn xy(&self, i: usize, high: bool) -> Option<Point> {
        let s = self.lay.segs.get(i)?;
        Some((self.to_point)(
            i64::from(s.k) * self.spacing,
            if high { s.t1 } else { s.t0 },
        ))
    }

    /// The link candidates walking along the wall from the `up` end of span `cur` toward the next line
    /// (`step` 1) or the previous one (-1).
    fn side(&self, cur: usize, up: bool, step: i32) -> Option<Side> {
        let here = self.lay.segs.get(cur)?;
        let b = self.xy(cur, up)?;
        self.edge.ring_of(b, 0.6)?;
        let forward = ((step == 1) != up) == self.proper;
        let mut horizontal: Option<Cand> = None;
        let mut vertical: Option<Cand> = None;
        let Some(from) = self.place(cur, up) else {
            return Some(Side { horizontal, vertical });
        };
        let nearest = |slot: &mut Option<Cand>, j: usize, high: bool| {
            let Some(entry) = self.xy(j, high) else { return };
            let Some((segments, len, at)) = self.edge.measure(from, b, entry, self.place(j, high), forward)
            else {
                return;
            };
            if slot.as_ref().is_none_or(|h| segments < h.segments) {
                *slot = Some(Cand {
                    segments,
                    len,
                    j,
                    via: Vec::new(),
                    at,
                });
            }
        };
        for j in self.lay.line_range(here.k + step) {
            nearest(&mut horizontal, j, up);
        }
        // The ends of the other kind on this line, this span's own other end included: on a strip narrower
        // than the lines it is the nearest, and then this side has no horizontal link.
        for j in self.lay.line_range(here.k) {
            nearest(&mut vertical, j, !up);
        }
        for c in horizontal.iter_mut().chain(vertical.iter_mut()) {
            c.via = self.edge.via(from, c.at, forward);
        }
        // A vertical link replaces the horizontal one only when strictly nearer.
        match (horizontal, vertical) {
            (Some(h), Some(v)) if v.segments < h.segments => Some(Side {
                horizontal: None,
                vertical: Some(v),
            }),
            (h, Some(v)) if h.is_none() => Some(Side {
                horizontal: None,
                vertical: Some(v),
            }),
            (h, _) => Some(Side {
                horizontal: h,
                vertical: None,
            }),
        }
    }

    /// Whether the end a vertical link reaches (span `j`; this span's own other end when `j` is `cur`) lies above the
    /// `up` end of span `cur`.
    fn above(cur: usize, up: bool, j: usize) -> bool {
        if j == cur { !up } else { j > cur }
    }

    /// The span on this line past a notch in the wall that the line goes on into from its `up` end, and the wall
    /// between. Both ways leading to ends on this line on the same side invalidate the link (Orca marks such a
    /// contour, which touches the line only, invalid).
    fn across(&self, cur: usize, up: bool, max: f64) -> Option<(usize, Vec<Point>)> {
        let j = if up { cur + 1 } else { cur.checked_sub(1)? };
        self.lay
            .segs
            .get(j)
            .filter(|s| self.lay.segs.get(cur).is_some_and(|c| c.k == s.k))?;
        let sides: Vec<Side> = [1, -1].iter().filter_map(|&s| self.side(cur, up, s)).collect();
        let verticals: Vec<&Cand> = sides.iter().filter_map(|s| s.vertical.as_ref()).collect();
        if let [a, b] = verticals.as_slice()
            && Self::above(cur, up, a.j) == Self::above(cur, up, b.j)
        {
            return None;
        }
        let v = verticals.into_iter().find(|v| v.j == j && v.len <= max)?;
        Some((v.j, v.via.clone()))
    }
}

/// Spans joined across notches in the wall into one run each, with the path of each run from its low end
/// to its high end.
fn merge_runs(
    spans: &[Iv],
    spacing: i64,
    links: Links,
    to_point: &dyn Fn(i64, i64) -> Point,
    proper: bool,
) -> (Vec<Iv>, Vec<Vec<Point>>, Vec<usize>) {
    let lay = Layout::new(spans);
    let Some(edge) = links.edge else {
        return (spans.to_vec(), Vec::new(), (0..spans.len()).collect());
    };
    let c = Contour::new(&lay, edge, spacing, proper, to_point);
    let pt = |s: &Seg, high: bool| to_point(i64::from(s.k) * spacing, if high { s.t1 } else { s.t0 });
    let mut merged: Vec<Iv> = Vec::new();
    let mut paths: Vec<Vec<Point>> = Vec::new();
    // The run each span belongs to.
    let mut owner: Vec<usize> = Vec::with_capacity(spans.len());
    let mut i = 0;
    while let Some(first) = lay.segs.get(i).copied() {
        let mut run = Iv {
            k: first.k,
            t0: first.t0,
            t1: first.t1,
        };
        let mut path = vec![pt(&first, false), pt(&first, true)];
        let mut last = i;
        while let Some((j, via)) = c.across(last, true, links.max) {
            let Some(s) = lay.segs.get(j).copied() else { break };
            path.extend(via);
            path.push(pt(&s, false));
            path.push(pt(&s, true));
            run.t1 = s.t1;
            last = j;
        }
        owner.extend(std::iter::repeat_n(merged.len(), last + 1 - i));
        merged.push(run);
        paths.push(path);
        i = last + 1;
    }
    (merged, paths, owner)
}

fn polylines_core(
    spans: &[Iv],
    outer: &[Iv],
    spacing: i64,
    links: Links,
    to_point: &dyn Fn(i64, i64) -> Point,
) -> Vec<Vec<Point>> {
    let proper = {
        let (o, ds, dt) = (to_point(0, 0), to_point(1_000_000, 0), to_point(0, 1_000_000));
        let cross =
            f64::from(ds.x - o.x) * f64::from(dt.y - o.y) - f64::from(ds.y - o.y) * f64::from(dt.x - o.x);
        cross > 0.0
    };
    // With the wall known, spans on one line that the wall joins across a notch are one run.
    let (merged, run_paths, run_of) = if outer.is_empty() {
        (spans.to_vec(), Vec::new(), (0..spans.len()).collect())
    } else {
        merge_runs(spans, spacing, links, to_point, proper)
    };
    let lay = Layout::new(&merged);
    let segs = &lay.segs;
    let n = segs.len();
    // Neighbors of a run: the runs that any end of its spans is linked to along the wall (Orca's
    // `left_overlap` and `right_overlap` read the horizontal link of every inner intersection of the run).
    let lay0 = Layout::new(spans);
    let contour0 = links
        .edge
        .filter(|_| !outer.is_empty())
        .map(|edge| Contour::new(&lay0, edge, spacing, proper, to_point));
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (s, &r) in run_of.iter().enumerate() {
        if let Some(v) = members.get_mut(r) {
            v.push(s);
        }
    }
    let neighbors = |i: usize, step: i32| -> Vec<usize> {
        match &contour0 {
            Some(c) => {
                let mut v: Vec<usize> = members
                    .get(i)
                    .into_iter()
                    .flatten()
                    .flat_map(|&s| {
                        [false, true].into_iter().filter_map(move |up| {
                            c.side(s, up, step).and_then(|side| side.horizontal).map(|h| h.j)
                        })
                    })
                    .filter_map(|j| run_of.get(j).copied())
                    .filter(|&r| r != i)
                    .collect();
                v.sort_unstable();
                v.dedup();
                v
            }
            None => lay.neighbors(i, step),
        }
    };
    let contour = contour0.as_ref();
    let xy =
        |s: &Seg, high: bool| -> Point { to_point(i64::from(s.k) * spacing, if high { s.t1 } else { s.t0 }) };
    // The wall between two line ends, each a run and the end of it (high or low), when the turn from one to
    // the other is allowed: with the wall known, the link `Contour::side` found for that end and no longer
    // than `links.max`; else a chord or the nearer way round the wall.
    let turn_between = |pe: (usize, bool), ne: (usize, bool)| -> Option<Vec<Point>> {
        if let Some(c) = contour {
            let orig = |(r, high): (usize, bool)| -> Option<(usize, bool)> {
                let ms = members.get(r)?;
                Some(if high {
                    (*ms.last()?, true)
                } else {
                    (*ms.first()?, false)
                })
            };
            let (a, b) = (orig(pe)?, orig(ne)?);
            [1, -1].into_iter().find_map(|step| {
                let h = c.side(a.0, a.1, step)?.horizontal?;
                (h.j == b.0 && h.len <= links.max).then_some(h.via)
            })
        } else {
            let (pa, pb) = (xy(segs.get(pe.0)?, pe.1), xy(segs.get(ne.0)?, ne.1));
            links.between(pa, pb)
        }
    };
    // The end of a path goes out to the outer contour: where the span that holds this line's span ends.
    let reach = |i: usize, high: bool| -> Option<Point> {
        let s = lay.segs.get(i)?;
        Some(to_point(i64::from(s.k) * spacing, lay.reach_t(outer, i, high)?))
    };

    let mut consumed = vec![false; n];
    let mut regions: Vec<Region> = Vec::new();
    for start in 0..n {
        if consumed.get(start).copied().unwrap_or(true) {
            continue;
        }
        let mut chain = vec![start];
        if let Some(c) = consumed.get_mut(start) {
            *c = true;
        }
        let mut cur = start;
        loop {
            let rights = neighbors(cur, 1);
            let [next] = rights.as_slice() else { break };
            if consumed.get(*next).copied().unwrap_or(true) || neighbors(*next, -1) != [cur] {
                break;
            }
            if let Some(c) = consumed.get_mut(*next) {
                *c = true;
            }
            chain.push(*next);
            cur = *next;
        }
        regions.push(Region {
            segs: chain,
            left: Vec::new(),
            right: Vec::new(),
        });
    }
    // Which region holds each span, then the left and right neighbors of every region.
    let mut owner = vec![usize::MAX; n];
    for (r, reg) in regions.iter().enumerate() {
        for &s in &reg.segs {
            if let Some(o) = owner.get_mut(s) {
                *o = r;
            }
        }
    }
    for r in 0..regions.len() {
        let Some((Some(first), Some(last))) = regions
            .get(r)
            .map(|g| (g.segs.first().copied(), g.segs.last().copied()))
        else {
            continue;
        };
        let mut left: Vec<usize> = neighbors(first, -1)
            .into_iter()
            .filter_map(|s| owner.get(s).copied())
            .collect();
        left.sort_unstable();
        left.dedup();
        let mut right: Vec<usize> = neighbors(last, 1)
            .into_iter()
            .filter_map(|s| owner.get(s).copied())
            .collect();
        right.sort_unstable();
        right.dedup();
        if let Some(g) = regions.get_mut(r) {
            g.left = left;
            g.right = right;
        }
    }

    // The pieces a region is printed as when it starts on the low side (false) or the high side, each with the
    // span end it starts on and the span end it stops on.
    let trace = |reg: &Region, from_high: bool| -> Vec<Piece> {
        let mut pieces: Vec<Piece> = Vec::new();
        let mut high = from_high;
        let mut prev_end: Option<(usize, bool)> = None;
        for &si in &reg.segs {
            let Some(s) = segs.get(si) else { continue };
            // Going from the low end to the high end when starting low; a run goes round its notches.
            let mut run: Vec<Point> = match run_paths.get(si) {
                Some(p) if !p.is_empty() => p.clone(),
                _ => vec![xy(s, false), xy(s, true)],
            };
            if high {
                run.reverse();
            }
            let turn = prev_end.and_then(|pe| turn_between(pe, (si, high)));
            match (pieces.last_mut(), turn) {
                (Some(last), Some(via)) => {
                    last.0.extend(via);
                    last.0.extend(run);
                    last.2 = (si, !high);
                }
                _ => pieces.push((run, (si, high), (si, !high))),
            }
            // The next line starts on the side this one ended on.
            prev_end = Some((si, !high));
            high = !high;
        }
        pieces
    };

    // One ant: a walk through the regions, each after the regions on its left, continuing into a right
    // neighbor when the turn is allowed and otherwise jumping to the nearest start. `forced` fixes the
    // first region and side. Returns the regions in order (region, starts high, joined to the previous one)
    // and the length of the jumps and turns between them.
    let walk = |forced: Option<(usize, bool)>| -> (Vec<(usize, bool, bool)>, f64) {
        let mut order: Vec<(usize, bool, bool)> = Vec::new();
        let mut done = vec![false; regions.len()];
        let mut remaining = regions.len();
        let mut last: Option<usize> = None;
        let mut cursor: Option<Point> = None;
        let mut cursor_end: Option<(usize, bool)> = None;
        let mut total = 0.0;
        let mut forced = forced;
        while remaining > 0 {
            let ready = |r: usize| {
                !done.get(r).copied().unwrap_or(true)
                    && regions
                        .get(r)
                        .is_some_and(|g| g.left.iter().all(|&l| done.get(l).copied().unwrap_or(true)))
            };
            let first_of = |r: usize| {
                regions
                    .get(r)
                    .and_then(|g| g.segs.first())
                    .and_then(|&i| segs.get(i))
            };
            let mut pick: Option<(usize, bool, f64, bool)> = forced.take().map(|(r, h)| (r, h, 0.0, false));
            if pick.is_none() {
                // Continue into a right neighbor of the last region when it is ready and the turn is
                // allowed from the side chosen, else take the ready region whose start is nearest (the
                // lowest line first at the very beginning).
                let consider = |r: usize, pick: &mut Option<(usize, bool, f64, bool)>, cont: bool| {
                    let Some(first) = first_of(r) else { return };
                    let Some(&first_idx) = regions.get(r).and_then(|g| g.segs.first()) else {
                        return;
                    };
                    for high in [false, true] {
                        if cont && cursor_end.is_none_or(|ce| turn_between(ce, (first_idx, high)).is_none()) {
                            continue;
                        }
                        let key = match cursor {
                            Some(c) => dist(c, xy(first, high)),
                            None => f64::from(first.k) * 1e6 + if high { 1.0 } else { 0.0 },
                        };
                        if pick.is_none_or(|(_, _, pk, _)| key < pk) {
                            *pick = Some((r, high, key, cont));
                        }
                    }
                };
                if let Some(g) = last.and_then(|l| regions.get(l)) {
                    for &r in g.right.iter().filter(|&&r| ready(r)) {
                        consider(r, &mut pick, true);
                    }
                }
                if pick.is_none() {
                    for r in (0..regions.len()).filter(|&r| ready(r)) {
                        consider(r, &mut pick, false);
                    }
                }
            }
            let Some((r, high, _, cont)) = pick else { break };
            let (Some(reg), Some(first)) = (regions.get(r), first_of(r)) else {
                break;
            };
            if let Some(c) = cursor {
                total += dist(c, xy(first, high));
            }
            order.push((r, high, cont));
            let pieces = trace(reg, high);
            cursor = pieces.last().and_then(|p| p.0.last().copied());
            cursor_end = pieces.last().map(|p| p.2);
            if let Some(d) = done.get_mut(r) {
                *d = true;
            }
            remaining -= 1;
            last = Some(r);
        }
        (order, total)
    };
    // Ants: the greedy walk from each of the first few possible starts, the shortest kept (Orca sends 10
    // ants over up to 25 rounds and keeps the shortest path; this is the same search without the dice).
    let starts: Vec<(usize, bool)> = (0..regions.len())
        .filter(|&r| regions.get(r).is_some_and(|g| g.left.is_empty()))
        .take(MAX_ANTS)
        .flat_map(|r| [(r, false), (r, true)])
        .collect();
    let mut best = walk(None);
    if regions.len() > 1 && regions.len() <= MAX_ANT_REGIONS {
        for s in starts {
            let cand = walk(Some(s));
            if cand.0.len() == regions.len() && cand.1 + 1e-9 < best.1 {
                best = cand;
            }
        }
    }
    let mut out: Vec<Piece> = Vec::new();
    for (r, high, cont) in best.0 {
        let Some(reg) = regions.get(r) else { continue };
        let mut it = trace(reg, high).into_iter();
        if let Some(first) = it.next() {
            let turn = match (cont, out.last()) {
                (true, Some(prev)) => turn_between(prev.2, first.1),
                _ => None,
            };
            match (out.last_mut(), turn) {
                (Some(prev), Some(via)) => {
                    prev.0.extend(via);
                    prev.0.extend(first.0);
                    prev.2 = first.2;
                }
                _ => out.push(first),
            }
        }
        out.extend(it);
    }
    // The two ends of each path reach the outer contour.
    let out: Vec<Vec<Point>> = out
        .into_iter()
        .map(|(mut pts, first, last)| {
            if !outer.is_empty() {
                if let (Some(p), Some(r)) = (pts.first_mut(), reach(first.0, first.1)) {
                    *p = r;
                }
                if let (Some(p), Some(r)) = (pts.last_mut(), reach(last.0, last.1)) {
                    *p = r;
                }
            }
            pts
        })
        .collect();
    finish(out)
}

/// A printed piece with the span ends (span index, high end) it starts and stops on.
type Piece = (Vec<Point>, (usize, bool), (usize, bool));

/// Starting regions tried by the ordering search.
const MAX_ANTS: usize = 10;
/// Above this many regions a layer keeps the single greedy walk, so the search stays cheap.
const MAX_ANT_REGIONS: usize = 200;

/// `spans` of scanlines along `dir` in Orca's frame (see [`orca_point`]): lines left to right, bottom to top.
pub(crate) fn orca_spans(spans: &[Iv], dir: crate::infill::Dir) -> Vec<Iv> {
    let mut v: Vec<Iv> = spans
        .iter()
        .map(|s| Iv {
            k: if dir == crate::infill::Dir::D135 {
                -s.k
            } else {
                s.k
            },
            t0: -s.t1,
            t1: -s.t0,
        })
        .collect();
    v.sort_by_key(|s| (s.k, s.t0));
    v
}

/// The plate point at line offset `s` and position `t` in Orca's frame for lines along `dir`. Orca rotates
/// the surface so the lines are vertical, going left to right and bottom to top; for our scanline frames
/// that is `t` reversed, and `s` reversed on the 135 degree layers.
pub(crate) fn orca_point(dir: crate::infill::Dir, s: i64, t: i64) -> Point {
    if dir == crate::infill::Dir::D135 {
        dir.point(-s, -t)
    } else {
        dir.point(s, -t)
    }
}

/// Polylines for rectilinear fills: the sweep of Orca's `traverse_graph_generate_polylines`. From the
/// leftmost unused line, go up to its end, turn along the wall onto the neighboring line (the shorter turn
/// when both are possible, the previous line's on a tie), go back down it, and so on until no turn is
/// possible; a line that meets a notch in the wall goes on past it. Then start again at the leftmost unused
/// line. The frame is Orca's: lines left to right by `k`, bottom to top by `t`.
pub(crate) fn zigzag_with(
    spans: &[Iv],
    spacing: i64,
    outer: &[Iv],
    links: Links,
    to_point: &dyn Fn(i64, i64) -> Point,
) -> Vec<Vec<Point>> {
    zigzag_pass(spans, spacing, outer, links, to_point, None)
}

/// [`zigzag_with`] for the fills that keep one pattern from layer to layer (Orca's `consistent_pattern`, used
/// by zigzag, cross zag and locked zag): a path starts at the bottom of a line with an even `parity` of its
/// index and at the top of the others, and a turn only goes to the next line, never back to the previous.
/// `parity` gives the start direction of a line index (true: from the bottom).
pub(crate) fn zigzag_consistent(
    spans: &[Iv],
    spacing: i64,
    outer: &[Iv],
    links: Links,
    to_point: &dyn Fn(i64, i64) -> Point,
    parity: &dyn Fn(i32) -> bool,
) -> Vec<Vec<Point>> {
    zigzag_pass(spans, spacing, outer, links, to_point, Some(parity))
}

fn zigzag_pass(
    spans: &[Iv],
    spacing: i64,
    outer: &[Iv],
    links: Links,
    to_point: &dyn Fn(i64, i64) -> Point,
    consistent: Option<&dyn Fn(i32) -> bool>,
) -> Vec<Vec<Point>> {
    let lay = Layout::new(spans);
    let n = lay.segs.len();
    let xy = |i: usize, high: bool| -> Option<Point> {
        let s = lay.segs.get(i)?;
        Some(to_point(i64::from(s.k) * spacing, if high { s.t1 } else { s.t0 }))
    };
    // The line's ends at the outer contour: where the span on the same line that holds it ends. Only the
    // two ends of a path go out there, the turns happen on the inner contour.
    let reach = |i: usize, high: bool| -> Option<Point> {
        let s = lay.segs.get(i)?;
        Some(to_point(i64::from(s.k) * spacing, lay.reach_t(outer, i, high)?))
    };
    // Whether (line offset, position along the line) is a right-handed frame, as Orca's (x, y) is: the
    // walk direction along a wall that leads to the next line depends on it.
    let proper = {
        let (o, ds, dt) = (to_point(0, 0), to_point(1_000_000, 0), to_point(0, 1_000_000));
        let cross =
            f64::from(ds.x - o.x) * f64::from(dt.y - o.y) - f64::from(ds.y - o.y) * f64::from(dt.x - o.x);
        cross > 0.0
    };
    let contour = links
        .edge
        .map(|edge| Contour::new(&lay, edge, spacing, proper, to_point));
    let mut consumed = vec![false; n];
    let mut out: Vec<Vec<Point>> = Vec::new();
    let mut next_plain = 0;
    loop {
        // The next path starts at the leftmost line with a span not printed yet.
        let (start, mut up) = match consistent {
            None => {
                while consumed.get(next_plain).copied().unwrap_or(false) {
                    next_plain += 1;
                }
                if next_plain >= n {
                    break;
                }
                (next_plain, true)
            }
            Some(from_bottom) => {
                let Some(first) = (0..n).find(|&i| !consumed.get(i).copied().unwrap_or(true)) else {
                    break;
                };
                let k = lay.segs.get(first).map_or(0, |s| s.k);
                let forward = from_bottom(k);
                let range = lay.line_range(k);
                let pick = if forward {
                    range.clone().find(|&i| !consumed.get(i).copied().unwrap_or(true))
                } else {
                    range
                        .clone()
                        .rev()
                        .find(|&i| !consumed.get(i).copied().unwrap_or(true))
                };
                (pick.unwrap_or(first), forward)
            }
        };
        let mut poly: Vec<Point> = Vec::new();
        let mut cur = start;
        loop {
            if let Some(c) = consumed.get_mut(cur) {
                *c = true;
            }
            let (Some(a), Some(b)) = (xy(cur, !up), xy(cur, up)) else {
                break;
            };
            if poly.is_empty() {
                poly.push(reach(cur, !up).unwrap_or(a));
            }
            poly.push(b);
            let Some(c) = &contour else {
                if let (Some(last), Some(r)) = (poly.last_mut(), reach(cur, up)) {
                    *last = r;
                }
                break;
            };
            // Where to go from this end: along the wall to the neighboring line when a turn is allowed
            // (not too long, to a line not yet printed), else on along this line past a notch.
            let next = c.side(cur, up, 1);
            let prev = c.side(cur, up, -1);
            let usable = |s: &Option<Side>| -> Option<usize> {
                let h = s.as_ref()?.horizontal.as_ref()?;
                (h.len <= links.max && !consumed.get(h.j).copied().unwrap_or(true)).then_some(h.j)
            };
            let len_of = |s: &Option<Side>| {
                s.as_ref()
                    .and_then(|s| s.horizontal.as_ref())
                    .map_or(f64::MAX, |h| h.len)
            };
            let prev_ok = |s: &Option<Side>| if consistent.is_some() { None } else { usable(s) };
            let take = match (usable(&next), prev_ok(&prev)) {
                (Some(n), Some(p)) => Some(if len_of(&next) < len_of(&prev) {
                    (n, &next)
                } else {
                    (p, &prev)
                }),
                (Some(n), None) => Some((n, &next)),
                (None, Some(p)) => Some((p, &prev)),
                (None, None) => None,
            };
            if let Some((j, side)) = take
                && let Some(h) = side.as_ref().and_then(|s| s.horizontal.as_ref())
                && let Some(entry) = xy(j, up)
            {
                poly.extend(h.via.iter().copied());
                poly.push(entry);
                cur = j;
                up = !up;
                continue;
            }
            // Past a notch: the vertical link of either side, unless both lead the same way.
            let verticals: Vec<&Cand> = [&next, &prev]
                .into_iter()
                .filter_map(|s| s.as_ref()?.vertical.as_ref())
                .collect();
            let same_side = matches!(verticals.as_slice(), [a, b] if Contour::above(cur, up, a.j) == Contour::above(cur, up, b.j));
            let adjacent = if up { cur + 1 } else { cur.wrapping_sub(1) };
            let across = verticals.into_iter().find(|v| {
                !same_side
                    && v.j == adjacent
                    && v.len <= links.max
                    && lay
                        .segs
                        .get(v.j)
                        .zip(lay.segs.get(cur))
                        .is_some_and(|(x, y)| x.k == y.k)
                    && !consumed.get(v.j).copied().unwrap_or(true)
            });
            if let Some(v) = across
                && let Some(entry) = xy(v.j, !up)
            {
                poly.extend(v.via.iter().copied());
                poly.push(entry);
                cur = v.j;
                continue;
            }
            if let (Some(last), Some(r)) = (poly.last_mut(), reach(cur, up)) {
                *last = r;
            }
            break;
        }
        out.push(poly);
    }
    finish(out)
}

fn finish(mut out: Vec<Vec<Point>>) -> Vec<Vec<Point>> {
    for pl in &mut out {
        pl.dedup();
    }
    out.retain(|p| p.len() >= 2);
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn iv(k: i32, t0: i64, t1: i64) -> Iv {
        Iv { k, t0, t1 }
    }

    fn total(pls: &[Vec<Point>]) -> f64 {
        pls.iter()
            .flat_map(|p| p.windows(2))
            .map(|w| w[0].dist_mm(w[1]))
            .sum()
    }

    #[test]
    fn a_rectangle_is_one_zigzag() {
        let spans: Vec<Iv> = (0..10).map(|k| iv(k, 0, 200_000)).collect();
        let pls = polylines(
            &spans,
            Dir::D45,
            4_000,
            Links {
                edge: None,
                max: 10.0,
                chord_fallback: false,
            },
        );
        assert_eq!(pls.len(), 1);
        // Ten lines, each line turns into the next: 10 lines and 9 joins.
        assert_eq!(pls[0].len(), 20);
    }

    #[test]
    fn long_turns_lift_the_nozzle() {
        let spans: Vec<Iv> = (0..4).map(|k| iv(k, 0, 200_000)).collect();
        let pls = polylines(
            &spans,
            Dir::D45,
            4_000,
            Links {
                edge: None,
                max: 0.0,
                chord_fallback: false,
            },
        );
        assert_eq!(pls.len(), 4);
    }

    #[test]
    fn a_split_prints_the_left_part_first() {
        // One span on lines 0 and 1, two spans on line 2 (a notch), one span on line 3.
        let spans = vec![
            iv(0, 0, 100),
            iv(1, 0, 100),
            iv(2, 0, 40),
            iv(2, 60, 100),
            iv(3, 0, 100),
        ];
        let pls = polylines(
            &spans,
            Dir::D45,
            4_000,
            Links {
                edge: None,
                max: 1e9,
                chord_fallback: false,
            },
        );
        let points: usize = pls.iter().map(Vec::len).sum();
        // Every span is printed once, end to end.
        assert_eq!(points, 10);
        assert!(total(&pls) > 0.0);
    }
}
