// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The moves of one object's layers, and its tool change trips, against every other object of the plate.
//!
//! Every other object counts, not only the ones printed before: whether the plate's order meets them decides
//! what is reported, and the rest tells the report which orders would clear it.

use super::{EPS, Hit, Hits, Kind, Model, Moment, Part, Severity};
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::output::LayerPaths;

/// What one object's layers meet. `k` is the object's place in print order; `travel_speed` and `lift_over_print`
/// ([`super::lifts_over_print`]) come from the run's settings, not the session's.
pub(crate) fn object_layers(
    model: &Model,
    k: usize,
    layers: &[LayerPaths],
    travel_speed: f64,
    lift_over_print: bool,
) -> Hits {
    object_layers_with(model, k, layers, travel_speed, lift_over_print, 0, None)
}

/// [`object_layers`] with the heads `heads` on from the machine's own (0 for them, the offset
/// [`super::Model::stretch`] returns for its stretched copies), against only the objects `only` lists when it is given.
pub(crate) fn object_layers_with(
    model: &Model,
    k: usize,
    layers: &[LayerPaths],
    travel_speed: f64,
    lift_over_print: bool,
    heads: usize,
    only: Option<&[usize]>,
) -> Hits {
    let mut w = Walker {
        m: model,
        k,
        heads,
        only,
        reach: model.reach(),
        travel_speed: travel_speed.max(1.0),
        lift_over_print,
        hits: Hits::default(),
        near: Vec::new(),
    };
    for l in layers {
        w.layer(l);
    }
    w.hits
}

/// Which pieces of the machine an object may meet on this layer.
#[derive(Clone, Copy)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "four checks that apply or not independently"
)]
struct Near {
    j: usize,
    head: bool,
    beam: bool,
    lid: bool,
    close: bool,
}

/// One probe: where the nozzle is and what the moment is.
#[derive(Clone, Copy)]
struct Probe {
    p: [f64; 3],
    tool: u8,
    travel: bool,
    layer: u32,
    segment: u32,
    share: f32,
    change: Option<(u8, u8, f32)>,
    /// On a tool change trip: the trip's kind for this leg.
    leg: Option<Kind>,
}

struct Walker<'a> {
    m: &'a Model,
    k: usize,
    /// Added to the head a tool prints with: which of the model's sets of heads this walk moves.
    heads: usize,
    /// The only objects the walk looks at, when given.
    only: Option<&'a [usize]>,
    reach: f64,
    travel_speed: f64,
    /// The change G-code lifts over the highest layer printed so far.
    lift_over_print: bool,
    hits: Hits,
    near: Vec<Near>,
}

fn mm(p: Point) -> [f64; 2] {
    [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE]
}

fn overlaps(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

impl Walker<'_> {
    fn layer(&mut self, l: &LayerPaths) {
        if l.paths.is_empty() {
            return;
        }
        let mut lo = [f64::MAX; 2];
        let mut hi = [f64::MIN; 2];
        for p in &l.points {
            let q = mm(*p);
            lo = [lo[0].min(q[0]), lo[1].min(q[1])];
            hi = [hi[0].max(q[0]), hi[1].max(q[1])];
        }
        let z0 = f64::from(l.z) + l.paths.iter().map(|p| f64::from(p.dz)).fold(0.0, f64::min)
            - if l.zs.is_empty() { 0.0 } else { f64::from(l.height) };
        let changes = self.m.changer.is_some()
            && l.paths
                .iter()
                .scan(l.start_tool, |t, p| {
                    let c = *t != 0 && p.tool != *t;
                    *t = p.tool;
                    Some(c)
                })
                .any(|c| c);
        self.near = self.nearby([lo[0], lo[1], hi[0], hi[1]], z0);
        if self.near.is_empty() && !changes {
            return;
        }
        // The layer's time by length over speed, for when each move happens.
        let speed_of = |p: &crate::output::PathInfo| f64::from(p.speed_mm_s).max(1.0);
        let mut total = 0.0;
        let mut last: Option<[f64; 2]> = l.enter_from.filter(|_| l.local > 0).map(mm);
        for p in &l.paths {
            let pts = l.path_points(p);
            if let (Some(a), Some(b)) = (last, pts.first()) {
                total += dist(a, mm(*b)) / self.travel_speed;
            }
            total += path_length(pts) / speed_of(p);
            last = pts.last().map(|q| mm(*q)).or(last);
        }
        let total = total.max(1e-9);
        let mut t = 0.0;
        let mut seg = 0u32;
        let mut last: Option<[f64; 3]> = l.enter_from.filter(|_| l.local > 0).map(|q| {
            let q = mm(q);
            [q[0], q[1], f64::from(l.z)]
        });
        let mut tool = l.start_tool;
        let z_of = |p: &crate::output::PathInfo, i: usize| -> f64 {
            l.zs.get(p.start as usize + i)
                .map_or(f64::from(l.z + p.dz), |&z| f64::from(z))
        };
        #[allow(clippy::cast_possible_truncation, reason = "a share of 0 to 1")]
        let share = |t: f64| (t / total).clamp(0.0, 1.0) as f32;
        for p in &l.paths {
            let pts = l.path_points(p);
            let Some(first) = pts.first().map(|q| {
                let q = mm(*q);
                [q[0], q[1], z_of(p, 0)]
            }) else {
                continue;
            };
            let base = Probe {
                p: first,
                tool: p.tool,
                travel: true,
                layer: l.index,
                segment: seg,
                share: share(t),
                change: None,
                leg: None,
            };
            if tool != 0 && p.tool != tool {
                self.change(
                    last.unwrap_or(first),
                    first,
                    tool,
                    p.tool,
                    f64::from(l.below_top),
                    base,
                );
            }
            tool = p.tool;
            if let Some(a) = last {
                self.segment(a, first, base);
                t += dist([a[0], a[1]], [first[0], first[1]]) / self.travel_speed;
            }
            if self.near.is_empty() {
                t += path_length(pts) / speed_of(p);
            } else {
                for (i, (a, b)) in pairs(pts).enumerate() {
                    let (a, b) = (mm(*a), mm(*b));
                    let pa = [a[0], a[1], z_of(p, i)];
                    let pb = [b[0], b[1], z_of(p, i + 1)];
                    let probe = Probe {
                        travel: false,
                        segment: seg + u32::try_from(i).unwrap_or(0),
                        share: share(t),
                        ..base
                    };
                    self.segment(pa, pb, probe);
                    t += dist(a, b) / speed_of(p);
                }
            }
            seg += u32::try_from(pts.len().saturating_sub(1)).unwrap_or(0);
            last = pts.last().map(|q| {
                let q = mm(*q);
                [q[0], q[1], z_of(p, pts.len().saturating_sub(1))]
            });
        }
    }

    /// The objects this layer's moves may meet: taller than the nozzle's lowest point here, within the head's reach
    /// or under the beam, or tall enough for the lid.
    fn nearby(&self, area: [f64; 4], z: f64) -> Vec<Near> {
        let m = self.m;
        let r = self.reach;
        let grown = [area[0] - r, area[1] - r, area[2] + r, area[3] + r];
        let round = [
            area[0] - m.radius,
            area[1] - m.radius,
            area[2] + m.radius,
            area[3] + m.radius,
        ];
        let mut out = Vec::new();
        for (j, o) in m.objects.iter().enumerate() {
            if j == self.k || self.only.is_some_and(|o| !o.contains(&j)) {
                continue;
            }
            let top = f64::from(o.top);
            let n = Near {
                j,
                head: top > z + f64::from(EPS) && overlaps(o.bounds, grown),
                // The bounds are whole cells: the mesh's rows run from bounds[1] to bounds[3] - 1.
                beam: top > z + m.rod
                    && super::rules::under_beam(
                        [o.bounds[1], o.bounds[3] - 1.0],
                        [area[1], area[3]],
                        m.to_rod,
                    ),
                lid: top > z + m.lid,
                close: top > z + m.nozzle_height && overlaps(o.bounds, round),
            };
            if n.head || n.beam || n.lid || n.close {
                out.push(n);
            }
        }
        out
    }

    /// Probes a straight move every cell along it.
    fn segment(&mut self, a: [f64; 3], b: [f64; 3], probe: Probe) {
        let len = dist([a[0], a[1]], [b[0], b[1]]);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "steps of a move a few hundred mm long"
        )]
        let n = (len / super::grid::CELL).ceil().max(1.0) as u32;
        for i in 0..=n {
            let s = f64::from(i) / f64::from(n);
            let p = [
                a[0] + s * (b[0] - a[0]),
                a[1] + s * (b[1] - a[1]),
                a[2] + s * (b[2] - a[2]),
            ];
            self.probe(Probe { p, ..probe });
        }
    }

    fn probe(&mut self, pr: Probe) {
        let m = self.m;
        let [x, y, z] = pr.p;
        let head = m.head(pr.tool) + self.heads;
        for idx in 0..self.near.len() {
            let Some(n) = self.near.get(idx).copied() else {
                continue;
            };
            let Some(o) = m.objects.get(n.j) else {
                continue;
            };
            let mut gap = Gap::new(&o.rim, [x, y]);
            let top = f64::from(o.top);
            if n.head {
                let fields = m.fields(n.j, head);
                let mut best: Option<(usize, f64, bool)> = None;
                for (ci, c) in m
                    .heads
                    .get(head)
                    .map_or(&[][..], Vec::as_slice)
                    .iter()
                    .enumerate()
                {
                    if top <= z + c.z0 + f64::from(EPS) {
                        continue;
                    }
                    let v = f64::from(fields.get(ci).map_or(0.0, |f| f.at(x, y)));
                    // How far the part rises past the box's underside; past the box's top it may hold nothing inside the
                    // box, which is checked on the mesh below.
                    let d = v - (z + c.z0);
                    if d > f64::from(EPS) && best.is_none_or(|(_, b, _)| d > b) {
                        best = Some((ci, d, v > z + c.z1));
                    }
                }
                if let Some((ci, d, above)) = best
                    && let Some(c) = m.heads.get(head).and_then(|h| h.get(ci))
                    && (!above
                        || super::grid::material_in(
                            o.surface(),
                            [x + c.x[0], x + c.x[1], y + c.y[0], y + c.y[1]],
                            z + c.z0,
                            z + c.z1,
                            [x, y],
                        ))
                {
                    let tip = c.z0 < super::TIP_Z;
                    let kind = pr.leg.unwrap_or(if pr.travel && tip {
                        Kind::NozzleTravelThroughPart
                    } else {
                        Kind::Hotend
                    });
                    let part = if tip { Part::Nozzle } else { Part::Toolhead };
                    let rect = [x + c.x[0], x + c.x[1], y + c.y[0], y + c.y[1]];
                    // The part's material inside the piece: from its underside up to the tallest the part stands there.
                    let region = o.struck(rect, z + c.z0, z + c.z0 + d);
                    #[allow(clippy::cast_possible_truncation, reason = "mm")]
                    self.record(
                        pr,
                        kind,
                        Severity::Hit,
                        part,
                        n.j,
                        d as f32,
                        region,
                        &mut gap,
                        |o| meeting(o, rect, z + c.z0, [x, y], true),
                    );
                }
            }
            if n.beam
                && let Some(b) = m.beam(n.j)
            {
                let d = f64::from(b.at(y)) - (z + m.rod);
                if d > f64::from(EPS) {
                    let rect = [o.bounds[0], o.bounds[2], y - m.to_rod, y + m.to_rod];
                    let kind = pr.leg.unwrap_or(Kind::Gantry);
                    // The part inside the beam's band, from the beam's underside to the part's height under it.
                    let region = o.struck(rect, z + m.rod, f64::from(b.at(y)));
                    #[allow(clippy::cast_possible_truncation, reason = "mm")]
                    self.record(
                        pr,
                        kind,
                        Severity::Hit,
                        Part::Gantry,
                        n.j,
                        d as f32,
                        region,
                        &mut gap,
                        |o| meeting(o, rect, z + m.rod, [x, y], false),
                    );
                }
            }
            if n.lid && top > z + m.lid {
                let rect = [o.bounds[0], o.bounds[2], o.bounds[1], o.bounds[3]];
                let kind = pr.leg.unwrap_or(Kind::Gantry);
                #[allow(clippy::cast_possible_truncation, reason = "mm")]
                self.record(
                    pr,
                    kind,
                    Severity::Hit,
                    Part::Lid,
                    n.j,
                    (top - z - m.lid) as f32,
                    o.struck(rect, z + m.lid, top),
                    &mut gap,
                    |o| meeting(o, rect, z + m.lid, [x, y], false),
                );
            }
            if n.close && pr.leg.is_none() && top > z + m.nozzle_height {
                let d = gap.get();
                // A head that is not measured cannot clear it by its own shape: the radius blocks, as in Bambu Studio.
                if let Some((severity, part)) = super::rules::radius_hit(d, m.radius, m.estimated) {
                    let short = m.radius - d;
                    // Where the radius holds as a hit, the part inside it above the nozzle; a close call has no region.
                    let r = m.radius;
                    let region = (severity == Severity::Hit)
                        .then(|| o.struck([x - r, x + r, y - r, y + r], z + m.nozzle_height, top))
                        .flatten();
                    #[allow(clippy::cast_possible_truncation, reason = "mm")]
                    self.record(
                        pr,
                        Kind::Hotend,
                        severity,
                        part,
                        n.j,
                        short as f32,
                        region,
                        &mut gap,
                        |o| {
                            let q = nearest_on_hull(&o.hull, [x, y]);
                            Some((
                                [q[0], q[1], (z + m.nozzle_height).min(f64::from(o.top))],
                                short as f32,
                            ))
                        },
                    );
                }
            }
        }
    }

    /// Notes a contact; where it lands is worked out only when it is the pair's first or deepest so far.
    #[allow(clippy::too_many_arguments, reason = "one contact's facts")]
    fn record(
        &mut self,
        pr: Probe,
        kind: Kind,
        severity: Severity,
        part: Part,
        j: usize,
        depth: f32,
        region: Option<[[f32; 3]; 2]>,
        gap: &mut Gap<'_>,
        contact: impl FnOnce(&super::Obstacle) -> Option<([f64; 3], f32)>,
    ) {
        let mover = u32::try_from(self.k).unwrap_or(u32::MAX);
        let obstacle = u32::try_from(j).unwrap_or(u32::MAX);
        let key = (kind, severity, part, mover, obstacle);
        let Some(o) = self.m.objects.get(j) else {
            return;
        };
        // The toolhead goes furthest in sideways where the nozzle is nearest the part.
        #[allow(clippy::cast_possible_truncation, reason = "mm")]
        let near = if part == Part::Toolhead {
            gap.get() as f32
        } else {
            f32::MAX
        };
        let had = self.hits.0.iter_mut().find(|h| h.key() == key);
        if let Some(h) = had
            && depth <= h.depth
            && near >= h.near - 0.25
        {
            h.last_layer = h.last_layer.max(pr.layer);
            h.moves += 1;
            return;
        }
        let (c, push) = contact(o).unwrap_or((pr.p, 0.0));
        #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
        let moment = Moment {
            layer: pr.layer,
            segment: pr.segment,
            share: pr.share,
            at: pr.p.map(|v| v as f32),
            point: c.map(|v| v as f32),
            change: pr.change,
        };
        self.hits.add(Hit {
            kind,
            severity,
            part,
            mover,
            obstacle,
            first: moment,
            worst: moment,
            depth,
            push,
            last_layer: pr.layer,
            moves: 1,
            near,
            contact: region,
        });
    }

    /// A tool change from `from` to `to` (1-based slots) between `at` and `resume`: the head lifts, makes the changer's
    /// stops and comes back. The stops before the switch carry the old tool's head, the rest the new one's. A change
    /// G-code that lifts over `max_layer_z`, as the makers' own do, clears everything printed so far (`printed`).
    fn change(&mut self, at: [f64; 3], resume: [f64; 3], from: u8, to: u8, printed: f64, base: Probe) {
        let m = self.m;
        let Some(ch) = m.changer.as_ref() else {
            return;
        };
        let stops = ch.route(usize::from(from.max(1) - 1), usize::from(to.max(1) - 1));
        let here = at[2].max(resume[2]);
        let top = if self.lift_over_print {
            here.max(printed)
        } else {
            here
        };
        let up = top + m.lift_mm;
        let mut pts: Vec<([f64; 3], bool)> = vec![(at, false), ([at[0], at[1], up], false)];
        for s in stops {
            pts.push(([s.x, s.y, top + s.dz], s.station));
        }
        let up_last = pts.last().map_or(up, |p| p.0[2]);
        pts.push(([resume[0], resume[1], up_last], false));
        pts.push((resume, false));
        let length: f64 = pairs(&pts).map(|(a, b)| dist3(a.0, b.0)).sum::<f64>().max(1e-9);
        // Every object may stand in the way of the trip; only those taller than it can.
        let mut lo = [f64::MAX; 2];
        let mut hi = [f64::MIN; 2];
        for (p, _) in &pts {
            lo = [lo[0].min(p[0]), lo[1].min(p[1])];
            hi = [hi[0].max(p[0]), hi[1].max(p[1])];
        }
        let route = self.nearby([lo[0], lo[1], hi[0], hi[1]], top);
        let kept = std::mem::replace(&mut self.near, route);
        for n in &mut self.near {
            n.close = false;
        }
        if !self.near.is_empty() {
            let mut along = 0.0;
            let tools = (from.max(1) - 1, to.max(1) - 1);
            for (i, (a, b)) in pairs(&pts).enumerate() {
                let (a, b) = (*a, *b);
                let kind = if a.1 || b.1 { Kind::Dock } else { Kind::ToolChange };
                // Up to the first stop the old tool is in the head.
                let tool = if i <= 1 { from } else { to };
                let len = dist3(a.0, b.0);
                #[allow(clippy::cast_possible_truncation, reason = "a share of 0 to 1")]
                let probe = Probe {
                    tool,
                    travel: true,
                    change: Some((tools.0, tools.1, (along / length) as f32)),
                    leg: Some(kind),
                    ..base
                };
                self.segment(a.0, b.0, probe);
                along += len;
            }
        }
        self.near = kept;
    }
}

/// Consecutive pairs of a list.
fn pairs<T>(v: &[T]) -> impl Iterator<Item = (&T, &T)> {
    v.windows(2).filter_map(|w| match w {
        [a, b] => Some((a, b)),
        _ => None,
    })
}

fn path_length(pts: &[Point]) -> f64 {
    pairs(pts).map(|(a, b)| dist(mm(*a), mm(*b))).sum()
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (b[0] - a[0]).m_hypot(b[1] - a[1])
}

fn dist3(a: [f64; 3], b: [f64; 3]) -> f64 {
    dist([a[0], a[1]], [b[0], b[1]]).m_hypot(b[2] - a[2])
}

/// Where a piece of the machine whose box is `rect` and whose underside is at `over` meets the part: on the part's
/// own material (`grid::meet`), and with `push` the sideways shift that clears it. Falls back to the height grid's
/// nearest tall cell at `over` when the mesh gives no point.
fn meeting(
    o: &super::Obstacle,
    rect: [f64; 4],
    over: f64,
    p: [f64; 2],
    push: bool,
) -> Option<([f64; 3], f32)> {
    #[allow(clippy::cast_possible_truncation, reason = "mm")]
    let near = o.grid().contact(rect, over as f32, p);
    let shift = if push { near.map_or(0.0, |n| n.1) } else { 0.0 };
    if let Some(q) = super::grid::meet(o.surface(), rect, over, p) {
        return Some((q, shift));
    }
    if let Some((c, _)) = near {
        return Some(([c[0], c[1], over.min(f64::from(o.top))], shift));
    }
    // The grids work in whole cells, so a contact at the edge of the box can sit up to a cell or two outside it.
    let g = 2.0 * super::grid::CELL;
    super::grid::meet(
        o.surface(),
        [rect[0] - g, rect[1] + g, rect[2] - g, rect[3] + g],
        over,
        p,
    )
    .map(|q| (q, shift))
}

/// A probe's distance to one obstacle's hull, worked out the first time it is asked for.
struct Gap<'h> {
    rim: &'h Rim,
    p: [f64; 2],
    d: Option<f64>,
}

impl<'h> Gap<'h> {
    fn new(rim: &'h Rim, p: [f64; 2]) -> Self {
        Self { rim, p, d: None }
    }

    fn get(&mut self) -> f64 {
        *self.d.get_or_insert_with(|| self.rim.distance(self.p))
    }
}

/// Edges per run of a [`Rim`].
const RUN: usize = 8;

/// A hull with its edges in runs of [`RUN`] and each run's box, so a probe's distance to it measures only the edges
/// near the probe. [`Rim::distance`] is [`hull_distance`] to the last bit.
#[derive(Debug, Clone, Default)]
pub(crate) struct Rim {
    hull: Vec<[f64; 2]>,
    /// Per run, the box `[min x, min y, max x, max y]` of its edges.
    runs: Vec<[f64; 4]>,
}

impl Rim {
    pub(crate) fn of(hull: &[[f64; 2]]) -> Self {
        let mut rim = Self {
            hull: hull.to_vec(),
            runs: Vec::new(),
        };
        // A hull with a corner that is not a number keeps no runs, so its distance is measured edge by edge.
        if hull.len() >= 3 && hull.iter().flatten().all(|v| v.is_finite()) {
            for start in (0..hull.len()).step_by(RUN) {
                let b = rim.edges(start).fold(
                    [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
                    |b, (p, q)| span_with(span_with(b, p), q),
                );
                rim.runs.push(b);
            }
        }
        rim
    }

    /// The edges of the run that starts at edge `start`.
    fn edges(&self, start: usize) -> impl Iterator<Item = ([f64; 2], [f64; 2])> + '_ {
        let n = self.hull.len();
        (start..(start + RUN).min(n))
            .filter_map(move |i| Some((*self.hull.get(i)?, *self.hull.get((i + 1) % n)?)))
    }

    /// The distance from `p` to the hull, 0 inside it.
    pub(crate) fn distance(&self, p: [f64; 2]) -> f64 {
        let n = self.hull.len();
        if self.runs.is_empty() || !(p[0].is_finite() && p[1].is_finite()) {
            return hull_distance(&self.hull, p);
        }
        if self.runs.len() == 1 {
            return few(&self.hull, p);
        }
        // Squared, an edge is no nearer than any box round it, which takes no division to measure.
        let floor = |b: [f64; 4]| {
            let dx = (b[0] - p[0]).max(p[0] - b[2]).max(0.0);
            let dy = (b[1] - p[1]).max(p[1] - b[3]).max(0.0);
            dx * dx + dy * dy
        };
        let square = |a: [f64; 2], b: [f64; 2]| {
            let q = nearest_on_segment(a, b, p);
            let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
            (dx * dx + dy * dy, q)
        };
        let cross = |a: [f64; 2], b: [f64; 2]| (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        // The run with the nearest box, and in it the nearest edge: a first bound.
        let Some(first) = (0..self.runs.len()).min_by(|&i, &j| {
            let (a, b) = (self.runs.get(i), self.runs.get(j));
            floor(a.copied().unwrap_or_default()).total_cmp(&floor(b.copied().unwrap_or_default()))
        }) else {
            return hull_distance(&self.hull, p);
        };
        let mut bound: Option<(f64, [f64; 2], [f64; 2])> = None;
        for (a, b) in self.edges(first * RUN) {
            let s = square(a, b).0;
            if bound.is_none_or(|(t, _, _)| s < t) {
                bound = Some((s, a, b));
            }
        }
        let Some((bound, a, b)) = bound.filter(|(s, _, _)| s.is_finite()) else {
            return hull_distance(&self.hull, p);
        };
        // Inside is every edge seeing `p` on its left; the nearest edge seeing it on its right settles it at once.
        if cross(a, b) >= 0.0
            && (0..n)
                .step_by(RUN)
                .flat_map(|r| self.edges(r))
                .all(|(a, b)| cross(a, b) >= 0.0)
        {
            return 0.0;
        }
        // An edge whose box lies past the bound, with a nanometer and a millionth to spare for rounding, can't be
        // nearest. Of the rest, the nearest by squared length, then the exact distance only to the edges within
        // rounding of it: the least distance over every edge.
        let reach = bound.sqrt() + 1e-6;
        let cap = reach * reach * (1.0 + 1e-6);
        let near = || {
            self.runs
                .iter()
                .enumerate()
                .filter(move |(_, b)| floor(**b) <= cap)
                .flat_map(move |(r, _)| self.edges(r * RUN))
                .filter(move |&(a, b)| floor(span_with(span_with([a[0], a[1], a[0], a[1]], a), b)) <= cap)
        };
        let least = near().map(|(a, b)| square(a, b).0).fold(f64::INFINITY, f64::min);
        let within = least * (1.0 + 1e-9) + 1e-300;
        near()
            .filter_map(|(a, b)| {
                let (s, q) = square(a, b);
                (s <= within).then(|| dist(p, q))
            })
            .fold(f64::INFINITY, f64::min)
    }
}

/// [`hull_distance`] for a hull of a few corners, at least three: the nearest edge by squared length, then the exact
/// distance only to the edges within rounding of it, the same least distance as measuring every edge.
fn few(hull: &[[f64; 2]], p: [f64; 2]) -> f64 {
    let n = hull.len();
    let edges = || (0..n).filter_map(move |i| Some((*hull.get(i)?, *hull.get((i + 1) % n)?)));
    if edges().all(|(a, b)| (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0.0) {
        return 0.0;
    }
    let square = |a: [f64; 2], b: [f64; 2]| {
        let q = nearest_on_segment(a, b, p);
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        (dx * dx + dy * dy, q)
    };
    let least = edges().map(|(a, b)| square(a, b).0).fold(f64::INFINITY, f64::min);
    if !least.is_finite() {
        return hull_distance(hull, p);
    }
    let within = least * (1.0 + 1e-9) + 1e-300;
    edges()
        .filter_map(|(a, b)| {
            let (s, q) = square(a, b);
            (s <= within).then(|| dist(p, q))
        })
        .fold(f64::INFINITY, f64::min)
}

/// The box `b` (`[min x, min y, max x, max y]`) grown to take in `p`.
fn span_with(b: [f64; 4], p: [f64; 2]) -> [f64; 4] {
    [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
}

/// Distance from `p` to a convex hull, 0 inside it.
pub(crate) fn hull_distance(hull: &[[f64; 2]], p: [f64; 2]) -> f64 {
    if hull.len() < 3 {
        return hull.first().map_or(f64::INFINITY, |q| dist(*q, p));
    }
    let n = hull.len();
    let mut inside = true;
    let mut best = f64::INFINITY;
    for i in 0..n {
        let (Some(a), Some(b)) = (hull.get(i), hull.get((i + 1) % n)) else {
            continue;
        };
        let cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        inside &= cross >= 0.0;
        best = best.min(dist(p, nearest_on_segment(*a, *b, p)));
    }
    if inside { 0.0 } else { best }
}

fn nearest_on_segment(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> [f64; 2] {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 <= 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    [a[0] + t * dx, a[1] + t * dy]
}

fn nearest_on_hull(hull: &[[f64; 2]], p: [f64; 2]) -> [f64; 2] {
    let n = hull.len();
    (0..n)
        .filter_map(|i| Some(nearest_on_segment(*hull.get(i)?, *hull.get((i + 1) % n)?, p)))
        .min_by(|a, b| dist(*a, p).total_cmp(&dist(*b, p)))
        .unwrap_or(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hull_distance_is_zero_inside_and_the_gap_outside() {
        let sq = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        assert!(hull_distance(&sq, [5.0, 5.0]).abs() < 1e-12);
        assert!((hull_distance(&sq, [13.0, 5.0]) - 3.0).abs() < 1e-12);
        assert!((hull_distance(&sq, [13.0, 14.0]) - 5.0).abs() < 1e-12);
    }

    /// A small repeatable source of numbers for the tests below.
    struct Draw(u64);

    impl Draw {
        #[allow(clippy::cast_precision_loss, reason = "53 random bits")]
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }

        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.next()
        }
    }

    /// Convex hulls of every kind the walk meets: round ones of many corners, squares, slivers, and ones with
    /// corners in a line or repeated.
    fn hulls(d: &mut Draw) -> Vec<Vec<[f64; 2]>> {
        let mut out = vec![
            vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
            vec![
                [0.0, 0.0],
                [5.0, 0.0],
                [10.0, 0.0],
                [10.0, 10.0],
                [10.0, 10.0],
                [0.0, 10.0],
            ],
            vec![[0.0, 0.0], [40.0, 0.1], [0.0, 0.2]],
        ];
        for _ in 0..60 {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a few corners"
            )]
            let n = 3 + (d.next() * 70.0) as usize;
            let (cx, cy, r) = (d.range(-50.0, 250.0), d.range(-50.0, 250.0), d.range(0.5, 40.0));
            let mut a: Vec<f64> = (0..n).map(|_| d.range(0.0, std::f64::consts::TAU)).collect();
            a.sort_by(f64::total_cmp);
            let even = d.next() < 0.5;
            let hull: Vec<[f64; 2]> = (0..n)
                .map(|i| {
                    #[allow(clippy::cast_precision_loss, reason = "a few corners")]
                    let t = if even {
                        std::f64::consts::TAU * i as f64 / n as f64
                    } else {
                        a[i]
                    };
                    [cx + r * t.m_cos(), cy + r * t.m_sin()]
                })
                .collect();
            out.push(hull);
        }
        out
    }

    #[test]
    fn a_rim_measures_a_hull_to_the_last_bit() {
        let mut d = Draw(11);
        let mut inside = 0;
        for hull in hulls(&mut d) {
            for h in [hull.clone(), hull.iter().rev().copied().collect()] {
                let rim = Rim::of(&h);
                let n = h.len();
                let (lo, hi) = h.iter().fold(([f64::MAX; 2], [f64::MIN; 2]), |(lo, hi), p| {
                    (
                        [lo[0].min(p[0]), lo[1].min(p[1])],
                        [hi[0].max(p[0]), hi[1].max(p[1])],
                    )
                });
                for k in 0..600 {
                    let p = match k % 4 {
                        // a corner, or a point on an edge
                        0 => h[k % n],
                        1 => {
                            let (a, b, t) = (h[k % n], h[(k + 1) % n], d.next());
                            [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
                        }
                        2 => [d.range(lo[0], hi[0]), d.range(lo[1], hi[1])],
                        _ => [
                            d.range(lo[0] - 120.0, hi[0] + 120.0),
                            d.range(lo[1] - 120.0, hi[1] + 120.0),
                        ],
                    };
                    let want = hull_distance(&h, p);
                    assert_eq!(rim.distance(p).to_bits(), want.to_bits(), "{h:?} {p:?}");
                    inside += usize::from(want == 0.0);
                }
            }
        }
        assert!(inside > 1000, "{inside}");
        // Fewer than three corners: as before.
        for h in [vec![], vec![[1.0, 2.0]], vec![[1.0, 2.0], [5.0, 2.0]]] {
            for p in [[0.0, 0.0], [3.0, 2.0]] {
                assert_eq!(Rim::of(&h).distance(p).to_bits(), hull_distance(&h, p).to_bits());
            }
        }
    }
}
