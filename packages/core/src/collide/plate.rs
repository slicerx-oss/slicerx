// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What a layer's own paths run into: the paths of another object, or of the prime tower, crossing on the same layer,
//! and print paths in a zone the printer keeps clear.
//!
//! `OrcaSlicer`, Bambu Studio and `PrusaSlicer` find crossing paths with `ConflictChecker::find_inter_of_lines_in_diff_objs`
//! (GCode/ConflictChecker.cpp): the walls and support of every object and the wipe tower, layer by layer, drawn on a
//! 1 mm grid, and only the first crossing of the whole print is reported. Here every pair of owners that cross is
//! reported, with the first and the last layer and how many crossings, supports and the prime tower included; support
//! against support is left out, as the support of neighbors joins on purpose. A layer whose owners' bounding boxes do
//! not overlap costs a box test per owner.

use super::{Hit, Hits, Kind, Moment, Part, Severity};
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::output::{Feature, LayerPaths, SliceOutput};
use std::collections::HashMap;

/// A keep-out zone from `bed_exclude_area`.
pub const ZONE_EXCLUSION: u8 = 0;
/// The corner the nozzle wrap check runs in (`head_wrap_detect_zone`, the A1 family).
pub const ZONE_WRAP_CHECK: u8 = 1;

/// The box around `pts`, grown by `room` on every side: `[x0, y0, x1, y1]`.
fn bounds(pts: &[[f64; 2]], room: f64) -> [f64; 4] {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for p in pts {
        b = [
            b[0].min(p[0] - room),
            b[1].min(p[1] - room),
            b[2].max(p[0] + room),
            b[3].max(p[1] + room),
        ];
    }
    b
}

/// The keep-out zones of the settings, each with its kind.
pub(crate) fn zones(config: &crate::config::PrintConfig) -> Vec<(u8, Vec<[f64; 2]>)> {
    let mut out = Vec::new();
    for z in crate::preflight::exclude_zones(config) {
        out.push((ZONE_EXCLUSION, z));
    }
    if let Some(poly) = crate::preflight::wrap_check_zone(config) {
        out.push((ZONE_WRAP_CHECK, poly));
    }
    out
}

fn mm(p: Point) -> [f64; 2] {
    [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE]
}

/// Two segments cross, touching aside.
fn cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let o =
        |p: [f64; 2], q: [f64; 2], r: [f64; 2]| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    let (d1, d2, d3, d4) = (o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b));
    d1 * d2 < -1e-9 && d3 * d4 < -1e-9
}

/// Where the segments `a`-`b` and `c`-`d` meet, for two that [`cross`].
fn crossing(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> [f64; 2] {
    let (r, q) = ([b[0] - a[0], b[1] - a[1]], [d[0] - c[0], d[1] - c[1]]);
    let den = r[0] * q[1] - r[1] * q[0];
    if den.abs() < 1e-12 {
        return [f64::midpoint(a[0], b[0]), f64::midpoint(a[1], b[1])];
    }
    let t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den;
    [a[0] + t * r[0], a[1] + t * r[1]]
}

/// One drawn segment: its owner, whether it is support, its ends and its index in the layer.
#[derive(Clone, Copy)]
struct Seg {
    owner: u32,
    support: bool,
    a: [f64; 2],
    b: [f64; 2],
    index: u32,
}

/// A travel the G-code writer wrote into keep-out zone `zone` (its place in [`zones`]): on plate layer `layer`, before
/// the layer's extrusion segment `segment` (as the preview counts them), `share` of the way through the layer, by the
/// object (or the prime tower, after the objects) `owner`, with the nozzle at `at` (mm) inside the zone.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WrittenTravel {
    pub layer: u32,
    pub segment: u32,
    pub share: f32,
    pub owner: u32,
    pub zone: u32,
    pub at: [f32; 3],
}

/// Adds the travels the G-code writer wrote into a keep-out zone to `hits`, as [`Kind::KeepOut`] hits of the object and
/// zone, for each pair [`check`] did not already report. [`check`] reads the paths before they are written and takes a
/// travel the router can take round a zone as clear; this reads what was written, so a travel written straight
/// through a zone anyway is still reported. `objects` is the plate's object count.
pub(crate) fn add_written_travels(hits: &mut Hits, objects: u32, travels: &[WrittenTravel]) {
    let reported: Vec<(u32, u32)> = hits
        .0
        .iter()
        .filter(|h| h.kind == Kind::KeepOut && h.part == Part::Nozzle && h.severity == Severity::Hit)
        .map(|h| (h.mover, h.obstacle))
        .collect();
    for t in travels {
        let obstacle = objects.saturating_add(1).saturating_add(t.zone);
        if reported.contains(&(t.owner, obstacle)) {
            continue;
        }
        let m = Moment {
            layer: t.layer,
            segment: t.segment,
            share: t.share,
            at: t.at,
            point: t.at,
            change: None,
        };
        hits.add(Hit {
            kind: Kind::KeepOut,
            severity: Severity::Hit,
            part: Part::Nozzle,
            mover: t.owner,
            obstacle,
            first: m,
            worst: m,
            depth: 0.0,
            push: 0.0,
            last_layer: t.layer,
            moves: 1,
            near: f32::MAX,
            contact: Some([t.at; 2]),
        });
    }
}

/// The crossings and keep-out moves of `out`'s layers. Owners are the plate's objects (`out.objects`), then the prime
/// tower; zone `k` is obstacle `objects + 1 + k`. `crossings` is off for a plate printed by object, whose objects do not
/// share layers. A travel meets a zone when it runs into it or passes within `clearance` of it (the nozzle's width),
/// and counts for the object it leaves, unless `router` takes it round the zone or over it, as the G-code does.
pub(crate) fn check(
    out: &SliceOutput,
    zones: &[(u8, Vec<[f64; 2]>)],
    crossings: bool,
    clearance: f64,
    router: Option<&crate::zoneroute::Router>,
) -> Hits {
    let mut hits = Hits::default();
    let n = u32::try_from(out.objects.len()).unwrap_or(u32::MAX);
    let mut boxes = Vec::with_capacity(zones.len());
    for (_, z) in zones {
        boxes.push(bounds(z, 0.0));
    }
    let clearance = clearance.max(0.0);
    // Objects whose footprints, with room for a brim and support around them, stand apart cannot cross; only a prime
    // tower near one can.
    let mut feet = Vec::with_capacity(out.objects.len());
    for o in &out.objects {
        feet.push(bounds(&o.hull, 10.0));
    }
    let meets = |a: &[f64; 4], b: &[f64; 4]| a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    let objects_meet = feet
        .iter()
        .enumerate()
        .any(|(i, a)| feet.iter().skip(i + 1).any(|b| meets(a, b)));
    for l in &out.layers {
        // Most layers meet no zone and have one owner: a box test and a feature scan decide that before any segment.
        let lb = l
            .points
            .iter()
            .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                let q = mm(*p);
                [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])]
            });
        let lb = l.enter_from.map(mm).map_or(lb, |q| {
            [lb[0].min(q[0]), lb[1].min(q[1]), lb[2].max(q[0]), lb[3].max(q[1])]
        });
        let near_zone = boxes.iter().any(|b| {
            b[0] - clearance <= lb[2]
                && lb[0] <= b[2] + clearance
                && b[1] - clearance <= lb[3]
                && lb[1] <= b[3] + clearance
        });
        let tower = l
            .paths
            .iter()
            .filter(|p| p.feature == Feature::PrimeTower)
            .flat_map(|p| l.path_points(p))
            .fold(None::<[f64; 4]>, |b, p| {
                let q = mm(*p);
                Some(b.map_or([q[0], q[1], q[0], q[1]], |b| {
                    [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])]
                }))
            });
        let owners = objects_meet || tower.is_some_and(|t| feet.iter().any(|f| meets(&t, f)));
        if !(near_zone || (crossings && owners)) {
            continue;
        }
        let segs = segments(l, n);
        if segs.is_empty() {
            continue;
        }
        let total = f32::from(u16::try_from(segs.len()).unwrap_or(u16::MAX)).max(1.0);
        let at = |s: &Seg, p: [f64; 2]| {
            #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
            let pt = [p[0] as f32, p[1] as f32, l.z];
            #[allow(clippy::cast_precision_loss, reason = "a share of 0 to 1")]
            let share = (s.index as f32 / total).min(1.0);
            Moment {
                layer: l.index,
                segment: s.index,
                share,
                at: pt,
                point: pt,
                change: None,
            }
        };
        let mut add = |kind: Kind, mover: u32, obstacle: u32, m: Moment, spot: Option<[f32; 3]>| {
            hits.add(Hit {
                kind,
                severity: Severity::Hit,
                part: Part::Nozzle,
                mover,
                obstacle,
                first: m,
                worst: m,
                depth: 0.0,
                push: 0.0,
                last_layer: m.layer,
                moves: 1,
                near: f32::MAX,
                // Where they meet; the pair's hits grow it into the box round every crossing.
                contact: Some([spot.unwrap_or(m.point); 2]),
            });
        };
        // Print paths in a keep-out zone: any move that runs more than the contact tolerance inside it, though its ends
        // lie clear, as the preflight judges it.
        for s in &segs {
            for (k, ((_, z), b)) in zones.iter().zip(&boxes).enumerate() {
                let tol = crate::preflight::EDGE_TOL_MM;
                let reach = [
                    s.a[0].min(s.b[0]),
                    s.a[1].min(s.b[1]),
                    s.a[0].max(s.b[0]),
                    s.a[1].max(s.b[1]),
                ];
                if reach[2] > b[0] + tol
                    && reach[0] < b[2] - tol
                    && reach[3] > b[1] + tol
                    && reach[1] < b[3] - tol
                    && let Some(p) = crate::preflight::segment_reaches(z, s.a, s.b, true, tol)
                {
                    add(
                        Kind::KeepOut,
                        s.owner,
                        n + 1 + u32::try_from(k).unwrap_or(0),
                        at(s, p),
                        None,
                    );
                }
            }
        }
        // Travels in a keep-out zone, or passing within the nozzle's width of it.
        if near_zone {
            for s in &travels(l, n) {
                for (k, ((_, z), b)) in zones.iter().zip(&boxes).enumerate() {
                    let reach = [
                        s.a[0].min(s.b[0]),
                        s.a[1].min(s.b[1]),
                        s.a[0].max(s.b[0]),
                        s.a[1].max(s.b[1]),
                    ];
                    if reach[2] > b[0] - clearance
                        && reach[0] < b[2] + clearance
                        && reach[3] > b[1] - clearance
                        && reach[1] < b[3] + clearance
                        && let Some(p) = crate::preflight::travel_meets(
                            z,
                            s.a,
                            s.b,
                            clearance,
                            crate::preflight::EDGE_TOL_MM,
                        )
                        && router.is_none_or(|r| {
                            r.route(s.a, s.b, f64::from(l.z)) == crate::zoneroute::Route::Blocked
                        })
                    {
                        add(
                            Kind::KeepOut,
                            s.owner,
                            n + 1 + u32::try_from(k).unwrap_or(0),
                            at(s, p),
                            None,
                        );
                    }
                }
            }
        }
        if !crossings {
            continue;
        }
        // Owners whose boxes overlap another's are the only ones drawn.
        let mut owners: Vec<(u32, [f64; 4])> = Vec::new();
        for s in &segs {
            let b = [
                s.a[0].min(s.b[0]),
                s.a[1].min(s.b[1]),
                s.a[0].max(s.b[0]),
                s.a[1].max(s.b[1]),
            ];
            match owners.iter_mut().find(|(o, _)| *o == s.owner) {
                Some((_, ob)) => *ob = [ob[0].min(b[0]), ob[1].min(b[1]), ob[2].max(b[2]), ob[3].max(b[3])],
                None => owners.push((s.owner, b)),
            }
        }
        let mut close = Vec::new();
        for (o, b) in &owners {
            if owners.iter().any(|(p, c)| p != o && meets(b, c)) {
                close.push(*o);
            }
        }
        if close.is_empty() {
            continue;
        }
        let mut grid: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
        for (i, s) in segs.iter().enumerate() {
            if !close.contains(&s.owner) {
                continue;
            }
            let len = (s.b[0] - s.a[0]).abs().max((s.b[1] - s.a[1]).abs());
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "steps along a move of a few hundred mm"
            )]
            let steps = (len * 2.0).ceil().max(1.0) as u32;
            let mut seen: Vec<(i32, i32)> = Vec::new();
            for k in 0..=steps {
                let t = f64::from(k) / f64::from(steps);
                #[allow(clippy::cast_possible_truncation, reason = "1 mm cells of the bed")]
                let c = (
                    (s.a[0] + t * (s.b[0] - s.a[0])).floor() as i32,
                    (s.a[1] + t * (s.b[1] - s.a[1])).floor() as i32,
                );
                if seen.contains(&c) {
                    continue;
                }
                seen.push(c);
                let cell = grid.entry(c).or_default();
                for &j in cell.iter() {
                    let Some(o) = segs.get(j) else {
                        continue;
                    };
                    if o.owner != s.owner && !(o.support && s.support) && cross(s.a, s.b, o.a, o.b) {
                        let (mover, obstacle) = (s.owner.max(o.owner), s.owner.min(o.owner));
                        let p = [f64::midpoint(s.a[0], s.b[0]), f64::midpoint(s.a[1], s.b[1])];
                        let q = crossing(s.a, s.b, o.a, o.b);
                        #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
                        let spot = [q[0] as f32, q[1] as f32, l.z];
                        add(Kind::PathConflict, mover, obstacle, at(s, p), Some(spot));
                    }
                }
                cell.push(i);
            }
        }
    }
    hits
}

/// Objects sliced together, in one session, whose own slices overlap on a layer by more than a line (`width`, mm).
/// Their areas merge into one region there, so no path of one crosses a path of the other and the overlap prints
/// once, as part of the first of them in plate order (`owners.rs`). Each pair is a hit with the later object as the
/// mover and the layers it overlaps on, read as a note (`api::overlap_notes`), not as a collision; objects that only
/// touch do not count. `slices` gives the objects' slices on a print layer (`SliceSession::print_layer_slices`).
pub(crate) fn overlaps(
    out: &SliceOutput,
    slices: &(dyn Fn(u32) -> Option<std::sync::Arc<crate::owners::Slices>> + Sync),
    width: f64,
) -> Hits {
    let inset = -crate::geom::mm(width / 2.0);
    let found = crate::par::map(&out.layers, |l| {
        let mut pairs = Vec::new();
        let Some(here) = slices(l.index) else {
            return pairs;
        };
        for (i, a) in here.iter().enumerate() {
            for b in here.iter().skip(i + 1) {
                let (p, q) = (a.bounds, b.bounds);
                if p[0] >= q[2] || q[0] >= p[2] || p[1] >= q[3] || q[1] >= p[3] {
                    continue;
                }
                let both = crate::perimeters::intersection(&a.shapes, &b.shapes);
                let Some(c) = crate::perimeters::bounds(&crate::perimeters::offset(&both, inset)) else {
                    continue;
                };
                #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
                let at = [
                    (f64::midpoint(f64::from(c[0]), f64::from(c[2])) / SCALE) as f32,
                    (f64::midpoint(f64::from(c[1]), f64::from(c[3])) / SCALE) as f32,
                    l.z,
                ];
                #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
                let region = [
                    [
                        (f64::from(c[0]) / SCALE) as f32,
                        (f64::from(c[1]) / SCALE) as f32,
                        l.z,
                    ],
                    [
                        (f64::from(c[2]) / SCALE) as f32,
                        (f64::from(c[3]) / SCALE) as f32,
                        l.z,
                    ],
                ];
                pairs.push((a.object.max(b.object), a.object.min(b.object), at, region));
            }
        }
        pairs
    });
    let mut hits = Hits::default();
    for (l, pairs) in out.layers.iter().zip(found) {
        for (mover, obstacle, at, region) in pairs {
            let m = Moment {
                layer: l.index,
                segment: 0,
                share: 0.0,
                at,
                point: at,
                change: None,
            };
            hits.add(Hit {
                kind: Kind::PathConflict,
                severity: Severity::Hit,
                part: Part::Nozzle,
                mover: u32::from(mover),
                obstacle: u32::from(obstacle),
                first: m,
                worst: m,
                depth: 0.0,
                push: 0.0,
                last_layer: l.index,
                moves: 1,
                near: f32::MAX,
                contact: Some(region),
            });
        }
    }
    hits
}

/// A layer's travels, straight from the end of one path to the start of the next (the travel into the layer from where
/// the layer below's last path ended first), each owned by the object it leaves, else the one it goes to. Travels to or from a
/// custom path (the printer's own G-code may go into its zones on purpose) and between skirt paths are left out. Its
/// index is the first segment of the path it goes to, as the preview counts them.
fn travels(l: &LayerPaths, tower: u32) -> Vec<Seg> {
    let mut out = Vec::new();
    let mut index = 0u32;
    // The layer below ended where its last path ends (its last stored point is not that when its paths were
    // reordered).
    let mut last: Option<(Point, Option<u32>, bool)> = l
        .below_wipe
        .points
        .last()
        .copied()
        .or(l.enter_from)
        .map(|q| (q, None, false));
    for p in &l.paths {
        let pts = l.path_points(p);
        let (Some(first), Some(end)) = (pts.first(), pts.last()) else {
            continue;
        };
        let custom = p.feature == Feature::Custom;
        let owner = match p.feature {
            Feature::PrimeTower => Some(tower),
            Feature::Skirt | Feature::Custom => None,
            _ => (p.owner != crate::preview::OBJECT_NONE).then_some(u32::from(p.owner)),
        };
        if let Some((from, from_owner, from_custom)) = last
            && !custom
            && !from_custom
            && let Some(owner) = from_owner.or(owner)
            && from != *first
        {
            out.push(Seg {
                owner,
                support: false,
                a: mm(from),
                b: mm(*first),
                index,
            });
        }
        index += u32::try_from(pts.len().saturating_sub(1)).unwrap_or(0);
        last = Some((*end, owner, custom));
    }
    out
}

/// How close a join may come to another owner's path before it stays a travel, mm.
const JOIN_CLEAR_MM: f64 = 0.05;

/// Distance between the segments `a`-`b` and `c`-`d` (0 when they cross).
fn seg_dist(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> f64 {
    let o =
        |p: [f64; 2], q: [f64; 2], r: [f64; 2]| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    let (d1, d2, d3, d4) = (o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b));
    if d1 * d2 <= 0.0 && d3 * d4 <= 0.0 && (d1 != 0.0 || d2 != 0.0 || d3 != 0.0 || d4 != 0.0) {
        return 0.0;
    }
    let pd = |p: [f64; 2], u: [f64; 2], v: [f64; 2]| {
        let (dx, dy) = (v[0] - u[0], v[1] - u[1]);
        let len2 = dx * dx + dy * dy;
        let t = if len2 == 0.0 {
            0.0
        } else {
            (((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / len2).clamp(0.0, 1.0)
        };
        let (x, y) = (u[0] + t * dx - p[0], u[1] + t * dy - p[1]);
        x.m_hypot(y)
    };
    pd(a, c, d).min(pd(b, c, d)).min(pd(c, a, b)).min(pd(d, a, b))
}

/// Drops the joins of the solid surfaces (top, bottom, internal solid) that would cross or touch another path on their
/// layer: a turn along the edge from one fill line to the next is new material, so where it meets another object's
/// path, the prime tower or a path of another tool, the nozzle travels instead (the writer then moves between the two
/// lines as between any two paths). The joins are the ones the fill made (`LayerPaths::joins`); the paths of the
/// join's own object and tool (its walls, a narrow band's beads, gap fill, the fill's own lines and joins) and the
/// paths a join connects do not count. Returns how many were dropped.
pub(crate) fn drop_crossing_joins(out: &mut SliceOutput) -> usize {
    // Each layer's joins are checked against its own paths alone, so the layers are checked side by side.
    let keeps = crate::par::map(&out.layers, crossing_keep);
    let mut dropped = 0;
    for (l, keep) in out.layers.iter_mut().zip(keeps) {
        let Some(keep) = keep else { continue };
        let before = l.paths.len();
        let mut it = keep.iter();
        l.paths.retain(|_| it.next().copied().unwrap_or(true));
        if l.paths.len() < before {
            // The G-code the cooling step wrote for the layer still has the turns, so the writer writes it again.
            l.written = None;
        }
        dropped += before - l.paths.len();
    }
    dropped
}

/// The 1 mm bed cell of a coordinate.
#[allow(clippy::cast_possible_truncation, reason = "1 mm cells of the bed")]
fn cell(v: f64) -> i32 {
    v.floor() as i32
}

/// The 1 mm cells within `r` of the segment `a`-`b`: in each column, the rows its stretch there spans, `r` and a hair
/// wider so that a point on a cell's edge reads both cells.
fn cells_on(a: [f64; 2], b: [f64; 2], r: f64) -> impl Iterator<Item = (i32, i32)> {
    const HAIR: f64 = 1e-6;
    let (lo, hi) = (cell(a[1].min(b[1]) - r), cell(a[1].max(b[1]) + r));
    (cell(a[0].min(b[0]) - r)..=cell(a[0].max(b[0]) + r)).flat_map(move |x| {
        let t = |v: f64| ((v - a[0]) / (b[0] - a[0])).clamp(0.0, 1.0);
        let (t0, t1) = if (b[0] - a[0]).abs() < HAIR {
            (0.0, 1.0)
        } else {
            (t(f64::from(x) - r - HAIR), t(f64::from(x) + 1.0 + r + HAIR))
        };
        let (y0, y1) = (a[1] + (b[1] - a[1]) * t0, a[1] + (b[1] - a[1]) * t1);
        (cell(y0.min(y1) - r - HAIR).max(lo)..=cell(y0.max(y1) + r + HAIR).min(hi)).map(move |y| (x, y))
    })
}

/// Which of a layer's paths [`drop_crossing_joins`] keeps, or `None` when the layer has no joins.
fn crossing_keep(l: &LayerPaths) -> Option<Vec<bool>> {
    let surface = |f: Feature| {
        matches!(
            f,
            Feature::TopSurface | Feature::BottomSurface | Feature::InternalSolid
        )
    };
    let same = |p: [f64; 2], q: [f64; 2]| (p[0] - q[0]).abs() < 1e-3 && (p[1] - q[1]).abs() < 1e-3;
    if l.joins.is_empty() {
        return None;
    }
    let joins: std::collections::HashSet<(Point, Point)> =
        l.joins.iter().flat_map(|&[a, b]| [(a, b), (b, a)]).collect();
    // Every segment of the layer, with the path it belongs to, by 1 mm cell of the bed. Ironing is left out: it
    // passes over the finished surface, turns included, and lays no line a turn could meet.
    let segs: Vec<(usize, [f64; 2], [f64; 2])> = l
        .paths
        .iter()
        .enumerate()
        .filter(|(_, p)| !matches!(p.feature, Feature::Custom | Feature::Ironing))
        .flat_map(|(i, p)| {
            l.path_points(p)
                .windows(2)
                .filter_map(move |w| match w {
                    [a, b] => Some((i, mm(*a), mm(*b))),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .collect();
    let is_join = |p: &crate::output::PathInfo| {
        surface(p.feature) && matches!(l.path_points(p), [a, b] if joins.contains(&(*a, *b)))
    };
    let ends = l
        .paths
        .iter()
        .filter(|p| is_join(p))
        .flat_map(|p| l.path_points(p))
        .map(|p| mm(*p));
    let (x0, y0, x1, y1) = ends.fold((i32::MAX, i32::MAX, i32::MIN, i32::MIN), |m, p| {
        (
            m.0.min(cell(p[0])),
            m.1.min(cell(p[1])),
            m.2.max(cell(p[0])),
            m.3.max(cell(p[1])),
        )
    });
    if x0 > x1 {
        return None;
    }
    #[allow(clippy::cast_sign_loss, reason = "offsets inside the box")]
    let at = |x: i32, y: i32| -> Option<usize> {
        (x >= x0 && x <= x1 && y >= y0 && y <= y1)
            .then(|| (y - y0) as usize * (x1 - x0 + 1) as usize + (x - x0) as usize)
    };
    // Only the cells a join that may go passes through are filled (a bitmap over their box says which), so the grid
    // stays small on a layer of many segments.
    let mut wanted = vec![false; at(x1, y1).map_or(0, |i| i + 1)];
    for p in l.paths.iter().filter(|p| is_join(p)) {
        if let [a, b] = l.path_points(p) {
            for (x, y) in cells_on(mm(*a), mm(*b), 0.0) {
                if let Some(w) = at(x, y).and_then(|i| wanted.get_mut(i)) {
                    *w = true;
                }
            }
        }
    }
    let mut grid: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    for (k, &(_, c, d)) in segs.iter().enumerate() {
        for (x, y) in cells_on(c, d, JOIN_CLEAR_MM) {
            if at(x, y).and_then(|i| wanted.get(i)).copied().unwrap_or(false) {
                grid.entry((x, y)).or_default().push(k);
            }
        }
    }
    let keep: Vec<bool> = l
        .paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let [pa, pb] = l.path_points(p) else { return true };
            if !is_join(p) {
                return true;
            }
            let (a, b) = (mm(*pa), mm(*pb));
            // A segment within reach of the join is filed under the cell of the join's nearest point.
            let near = cells_on(a, b, 0.0)
                .filter_map(|c| grid.get(&c))
                .flatten()
                .copied();
            // The fill's own lines and joins (two-point paths of the same surface, tool and width) are laid out by
            // the neighbor rules and may end right beside a turn; everything else counts.
            let own = |o: &crate::output::PathInfo| {
                o.feature == p.feature
                    && o.tool == p.tool
                    && o.end - o.start == 2
                    && (o.width_mm - p.width_mm).abs() < 1e-4
            };
            // A path of the join's own object and tool prints with it, from the same nozzle: its walls, a narrow
            // band's beads and gap fill do not stop a turn. Another object's path, the prime tower and another tool's
            // path still do.
            let mine = |o: &crate::output::PathInfo| {
                o.owner == p.owner
                    && p.owner != crate::preview::OBJECT_NONE
                    && o.tool == p.tool
                    && o.feature != Feature::PrimeTower
            };
            !near.filter_map(|k| segs.get(k)).any(|&(j, c, d)| {
                j != i
                    && !l.paths.get(j).is_some_and(|o| own(o) || mine(o))
                    && !(same(c, a) || same(c, b) || same(d, a) || same(d, b))
                    && seg_dist(a, b, c, d) < JOIN_CLEAR_MM
            })
        })
        .collect();
    Some(keep)
}

/// A layer's extrusion segments with their owners; skirts and custom paths own nothing and are left out.
fn segments(l: &LayerPaths, tower: u32) -> Vec<Seg> {
    let mut out = Vec::new();
    let mut index = 0u32;
    for p in &l.paths {
        let pts = l.path_points(p);
        let owner = match p.feature {
            Feature::PrimeTower => Some(tower),
            Feature::Skirt | Feature::Custom => None,
            _ => (p.owner != crate::preview::OBJECT_NONE).then_some(u32::from(p.owner)),
        };
        let support = matches!(p.feature, Feature::Support | Feature::SupportInterface);
        for w in pts.windows(2) {
            if let (Some(owner), [a, b]) = (owner, w) {
                out.push(Seg {
                    owner,
                    support,
                    a: mm(*a),
                    b: mm(*b),
                    index,
                });
            }
            index += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{ObjectFootprint, PathInfo};

    fn path(start: u32, end: u32, feature: Feature) -> PathInfo {
        PathInfo {
            tower_wipe: false,
            tower_hop: false,
            slow_span: false,
            start,
            end,
            tool: 1,
            feature,
            speed_mm_s: 50.0,
            width_mm: 0.42,
            flow: 1.0,
            dz: 0.0,
            overhang_fan: false,
            owner: crate::preview::OBJECT_NONE,
        }
    }

    fn footprint(id: &str, x: f64, y: f64, w: f64) -> ObjectFootprint {
        ObjectFootprint {
            id: id.to_owned(),
            name: id.to_owned(),
            hull: vec![[x, y], [x + w, y], [x + w, y + w], [x, y + w]],
            center: [x + w / 2.0, y + w / 2.0],
        }
    }

    /// One layer: a wall of object `a` round its square, a wall of `b` round its own, and a prime tower stroke.
    fn layer(a: (f64, f64), b: (f64, f64), tower: [(f64, f64); 2]) -> SliceOutput {
        let square =
            |(x, y): (f64, f64)| [(x, y), (x + 20.0, y), (x + 20.0, y + 20.0), (x, y + 20.0), (x, y)];
        let mut pts: Vec<Point> = Vec::new();
        for (x, y) in square(a).into_iter().chain(square(b)).chain(tower) {
            pts.push(Point::from_mm(x, y));
        }
        SliceOutput {
            layers: vec![LayerPaths {
                index: 3,
                z: 0.8,
                height: 0.2,
                points: pts,
                paths: vec![
                    PathInfo {
                        owner: 0,
                        ..path(0, 5, Feature::OuterWall)
                    },
                    PathInfo {
                        owner: 1,
                        ..path(5, 10, Feature::OuterWall)
                    },
                    path(10, 12, Feature::PrimeTower),
                ],
                ..LayerPaths::default()
            }],
            objects: vec![footprint("a", a.0, a.1, 20.0), footprint("b", b.0, b.1, 20.0)],
            ..SliceOutput::default()
        }
    }

    #[test]
    fn every_pair_that_crosses_is_found_the_tower_included() {
        // b overlaps a's corner, and the tower stroke runs through both
        let out = layer((50.0, 50.0), (60.0, 35.0), [(65.0, 40.0), (65.0, 90.0)]);
        let hits = check(&out, &[], true, 0.4, None);
        let mut pairs: Vec<(Kind, u32, u32)> = hits.0.iter().map(|h| (h.kind, h.mover, h.obstacle)).collect();
        pairs.sort();
        // object b against a, and the tower (owner 2) against both
        assert_eq!(
            pairs,
            [
                (Kind::PathConflict, 1, 0),
                (Kind::PathConflict, 2, 0),
                (Kind::PathConflict, 2, 1)
            ]
        );
        assert!(hits.0.iter().all(|h| h.first.layer == 3));
        // apart, nothing crosses, and printed by object nothing is tested
        assert!(
            check(
                &layer((50.0, 50.0), (100.0, 50.0), [(150.0, 40.0), (150.0, 90.0)]),
                &[],
                true,
                0.4,
                None,
            )
            .is_empty()
        );
        assert!(check(&out, &[], false, 0.4, None).is_empty());
    }

    #[test]
    fn the_wrap_check_zone_reads_strings_and_number_pairs() {
        let zone = |v| {
            let c =
                crate::config::PrintConfig::from_value(&serde_json::json!({ "head_wrap_detect_zone": v }))
                    .unwrap();
            zones(&c)
        };
        let want = vec![(
            ZONE_WRAP_CHECK,
            vec![[80.0, 95.0], [115.0, 95.0], [115.0, 125.0], [80.0, 125.0]],
        )];
        assert_eq!(
            zone(serde_json::json!(["80x95", "115x95", "115x125", "80x125"])),
            want
        );
        assert_eq!(
            zone(serde_json::json!([[80, 95], [115, 95], [115, 125], [80, 125]])),
            want
        );
    }

    #[test]
    fn a_path_in_a_keep_out_zone_is_found() {
        let out = layer((5.0, 5.0), (100.0, 50.0), [(150.0, 40.0), (150.0, 90.0)]);
        let zone = vec![(
            ZONE_EXCLUSION,
            vec![[0.0, 0.0], [18.0, 0.0], [18.0, 28.0], [0.0, 28.0]],
        )];
        let hits = check(&out, &zone, false, 0.4, None);
        assert_eq!(hits.0.len(), 1);
        // object a meets zone 0, named after the objects and the tower
        assert_eq!(
            (hits.0[0].kind, hits.0[0].mover, hits.0[0].obstacle),
            (Kind::KeepOut, 0, 3)
        );
    }

    /// Object a's wall round (40, 40) to (60, 60), then object b's round (100, 40) to (120, 60): the travel between
    /// them runs from (40, 40) to (100, 40).
    fn two_walls() -> SliceOutput {
        layer((40.0, 40.0), (100.0, 40.0), [(150.0, 100.0), (150.0, 140.0)])
    }

    fn zone_box(x: [f64; 2], y: [f64; 2]) -> Vec<(u8, Vec<[f64; 2]>)> {
        vec![(
            ZONE_EXCLUSION,
            vec![[x[0], y[0]], [x[1], y[0]], [x[1], y[1]], [x[0], y[1]]],
        )]
    }

    #[test]
    fn a_travel_through_a_keep_out_zone_is_found() {
        let hits = check(
            &two_walls(),
            &zone_box([70.0, 80.0], [35.0, 39.0]),
            false,
            0.4,
            None,
        );
        // The travel from a to b runs along y 40, 1 mm over the zone's top: clear.
        assert!(hits.is_empty(), "{hits:?}");
        let hits = check(
            &two_walls(),
            &zone_box([70.0, 80.0], [35.0, 45.0]),
            false,
            0.4,
            None,
        );
        assert_eq!(
            hits.0
                .iter()
                .map(|h| (h.kind, h.mover, h.obstacle))
                .collect::<Vec<_>>(),
            [(Kind::KeepOut, 0, 3)],
            "the travel counts for the object it leaves"
        );
        let p = hits.0[0].first.point;
        assert!(
            (70.0..=80.0).contains(&p[0]) && (p[1] - 40.0).abs() < 1e-3,
            "{p:?}"
        );
    }

    #[test]
    fn a_travel_the_router_takes_round_the_zone_is_not_a_hit() {
        let cfg = crate::config::PrintConfig::from_value(&serde_json::json!({
            "bed_exclude_area": [[70, 35], [80, 35], [80, 45], [70, 45]],
            "printable_area": [[0, 0], [256, 0], [256, 256], [0, 256]],
            "nozzle_diameter": [0.4],
        }))
        .unwrap();
        let router = crate::zoneroute::Router::of(&cfg).unwrap();
        let zone = zone_box([70.0, 80.0], [35.0, 45.0]);
        assert!(check(&two_walls(), &zone, false, 0.4, Some(&router)).is_empty());
        assert_eq!(check(&two_walls(), &zone, false, 0.4, None).0.len(), 1);
    }

    #[test]
    fn a_travel_written_through_a_zone_the_router_goes_round_is_reported() {
        let cfg = crate::config::PrintConfig::from_value(&serde_json::json!({
            "bed_exclude_area": [[70, 35], [80, 35], [80, 45], [70, 45]],
            "printable_area": [[0, 0], [256, 0], [256, 256], [0, 256]],
            "nozzle_diameter": [0.4],
        }))
        .unwrap();
        let router = crate::zoneroute::Router::of(&cfg).unwrap();
        let zone = zone_box([70.0, 80.0], [35.0, 45.0]);
        // The paths' check takes the travel from a to b as routed round the zone: no hit.
        let mut hits = check(&two_walls(), &zone, false, 0.4, Some(&router));
        assert!(hits.is_empty(), "{hits:?}");
        // Written straight through it anyway, it is reported, for the object it leaves and the zone (obstacle 3).
        let through = WrittenTravel {
            layer: 0,
            segment: 4,
            share: 0.5,
            owner: 0,
            zone: 0,
            at: [75.0, 40.0, 0.2],
        };
        add_written_travels(&mut hits, 2, std::slice::from_ref(&through));
        assert_eq!(
            hits.0
                .iter()
                .map(|h| (h.kind, h.severity, h.mover, h.obstacle, h.moves))
                .collect::<Vec<_>>(),
            [(Kind::KeepOut, Severity::Hit, 0, 3, 1)]
        );
        let p = hits.0[0].first.point;
        assert!((p[0] - 75.0).abs() < 1e-6 && (p[1] - 40.0).abs() < 1e-6, "{p:?}");
        // A pair the paths' check already reported keeps its record as it was.
        let mut reported = check(&two_walls(), &zone, false, 0.4, None);
        let before = reported.clone();
        add_written_travels(&mut reported, 2, &[through]);
        assert_eq!(reported, before);
    }

    #[test]
    fn a_travel_within_the_nozzle_width_of_a_zone_is_found() {
        // 0.3 mm under the travel: inside a 0.4 mm nozzle's width, outside a 0.2 mm one.
        let zone = zone_box([70.0, 80.0], [35.0, 39.7]);
        assert_eq!(check(&two_walls(), &zone, false, 0.4, None).0.len(), 1);
        assert!(check(&two_walls(), &zone, false, 0.2, None).is_empty());
    }

    #[test]
    fn a_travel_that_starts_beside_a_zone_and_leaves_it_is_clear() {
        // a's wall runs 0.2 mm from the zone along its left side: the print path is allowed there, and the travel to
        // b leaves the zone behind.
        let zone = zone_box([30.0, 39.8], [30.0, 70.0]);
        assert!(check(&two_walls(), &zone, false, 0.4, None).is_empty());
    }

    #[test]
    fn a_join_that_meets_its_own_objects_path_stays() {
        // A narrow band's bead, a wall or gap fill of the same object and tool across the turn prints with the
        // surface: the turn stays.
        for (other, width) in [
            (Feature::InternalSolid, 0.372),
            (Feature::InnerWall, 0.45),
            (Feature::GapFill, 0.2),
        ] {
            let mut out = joined_lines(other, width);
            assert_eq!(drop_crossing_joins(&mut out), 0, "{other:?}");
            assert_eq!(out.layers[0].paths.len(), 4);
        }
    }

    #[test]
    fn a_join_of_no_known_object_still_meets_every_path() {
        // A turn whose object is not known cannot tell its own paths apart: a bead or a wall across it drops it.
        for (other, width) in [(Feature::InternalSolid, 0.372), (Feature::InnerWall, 0.45)] {
            let mut out = joined_lines(other, width);
            for p in &mut out.layers[0].paths {
                p.owner = crate::preview::OBJECT_NONE;
            }
            assert_eq!(drop_crossing_joins(&mut out), 1, "{other:?}");
            assert_eq!(out.layers[0].paths.len(), 3);
        }
    }

    #[test]
    fn a_dropped_join_leaves_no_settled_gcode_behind() {
        // A short layer the cooling step wrote and left as it was keeps that G-code for the writer. A turn dropped
        // afterwards must not stay in it, or whether the turn prints would follow the layer's time.
        let mut out = joined_lines(Feature::InnerWall, 0.45);
        // The wall is another object's, so it still drops the turn.
        if let Some(wall) = out.layers[0].paths.get_mut(3) {
            wall.owner = 2;
        }
        let config = crate::config::PrintConfig {
            slow_down_for_layer_cooling: false,
            ..crate::config::PrintConfig::default()
        };
        crate::gcode::settle_cooling(&mut out, &config, (None, None));
        assert!(out.layers[0].written.is_some());
        assert_eq!(drop_crossing_joins(&mut out), 1);
        assert!(out.layers[0].written.is_none());
    }

    /// Two internal solid lines joined by a turn along the top, and one more path across the turn: `other` with its
    /// feature and width.
    fn joined_lines(other: Feature, width: f32) -> SliceOutput {
        let pts: Vec<Point> = [
            (0.0, 0.0),
            (0.0, 10.0),
            (0.0, 10.0),
            (1.0, 10.0),
            (1.0, 10.0),
            (1.0, 0.0),
            (0.5, 9.5),
            (0.5, 10.5),
        ]
        .into_iter()
        .map(|(x, y)| Point::from_mm(x, y))
        .collect();
        let mut cross = path(6, 8, other);
        cross.width_mm = width;
        // The lines, the turn and the path across it all belong to object 1 and print with tool 1.
        let mut paths = vec![
            path(0, 2, Feature::InternalSolid),
            path(2, 4, Feature::InternalSolid),
            path(4, 6, Feature::InternalSolid),
            cross,
        ];
        for p in &mut paths {
            p.owner = 1;
        }
        SliceOutput {
            layers: vec![LayerPaths {
                index: 3,
                z: 0.8,
                height: 0.2,
                joins: vec![[Point::from_mm(0.0, 10.0), Point::from_mm(1.0, 10.0)]],
                points: pts,
                paths,
                ..LayerPaths::default()
            }],
            ..SliceOutput::default()
        }
    }

    #[test]
    fn a_join_that_meets_another_path_stays_a_travel() {
        // A narrow band's bead (internal solid at its own width) or a wall across the turn, of another object or
        // another tool: the turn is dropped, the lines stay.
        for (other, width) in [(Feature::InternalSolid, 0.372), (Feature::InnerWall, 0.45)] {
            for (owner, tool) in [(2, 1), (1, 2)] {
                let mut out = joined_lines(other, width);
                if let Some(cross) = out.layers[0].paths.get_mut(3) {
                    (cross.owner, cross.tool) = (owner, tool);
                }
                assert_eq!(
                    drop_crossing_joins(&mut out),
                    1,
                    "{other:?}, object {owner}, tool {tool}"
                );
                let l = &out.layers[0];
                assert_eq!(l.paths.len(), 3);
                assert!(
                    l.paths
                        .iter()
                        .all(|p| l.path_points(p) != [Point::from_mm(0.0, 10.0), Point::from_mm(1.0, 10.0)])
                );
            }
        }
        // The prime tower across the turn: dropped.
        let mut out = joined_lines(Feature::PrimeTower, 0.5);
        if let Some(cross) = out.layers[0].paths.get_mut(3) {
            cross.owner = crate::preview::OBJECT_NONE;
        }
        assert_eq!(drop_crossing_joins(&mut out), 1);
        assert_eq!(out.layers[0].paths.len(), 3);
        // A line of the same fill there (same feature, tool and width) is laid out by the neighbor rules: kept.
        let mut out = joined_lines(Feature::InternalSolid, 0.42);
        assert_eq!(drop_crossing_joins(&mut out), 0);
        assert_eq!(out.layers[0].paths.len(), 4);
    }

    #[test]
    fn ironing_over_the_surface_keeps_its_joins() {
        // Ironing runs over the finished surface, turns and all, so it is no path a turn would meet: the turn stays.
        let mut out = joined_lines(Feature::Ironing, 0.45);
        assert_eq!(drop_crossing_joins(&mut out), 0);
        assert_eq!(out.layers[0].paths.len(), 4);
    }

    /// The paths the crossing check kept before it walked a join's cells: every segment filed under any cell of the
    /// join's box, read once per cell. Also returns how many of those reads were repeats.
    fn box_keep(l: &LayerPaths) -> (Vec<bool>, usize) {
        let joins: std::collections::HashSet<(Point, Point)> =
            l.joins.iter().flat_map(|&[a, b]| [(a, b), (b, a)]).collect();
        let segs: Vec<(usize, [f64; 2], [f64; 2])> = (l.paths.iter().enumerate())
            .flat_map(|(i, p)| l.path_points(p).windows(2).map(move |w| (i, mm(w[0]), mm(w[1]))))
            .collect();
        let span = |u: f64, v: f64, r: f64| cell(u.min(v) - r)..=cell(u.max(v) + r);
        let mut repeats = 0;
        let keep = (l.paths.iter().enumerate())
            .map(|(i, p)| {
                let [pa, pb] = l.path_points(p) else { return true };
                if p.feature != Feature::InternalSolid || !joins.contains(&(*pa, *pb)) {
                    return true;
                }
                let (a, b) = (mm(*pa), mm(*pb));
                let mut near = Vec::new();
                for x in span(a[0], b[0], 0.0) {
                    for y in span(a[1], b[1], 0.0) {
                        near.extend((segs.iter().enumerate()).filter(|&(_, &(_, c, d))| {
                            span(c[0], d[0], JOIN_CLEAR_MM).contains(&x)
                                && span(c[1], d[1], JOIN_CLEAR_MM).contains(&y)
                        }));
                    }
                }
                let mut seen = std::collections::HashSet::new();
                repeats += near.iter().filter(|(k, _)| !seen.insert(*k)).count();
                let same =
                    |p: [f64; 2], q: [f64; 2]| (p[0] - q[0]).abs() < 1e-3 && (p[1] - q[1]).abs() < 1e-3;
                let own = |o: &PathInfo| o.feature == p.feature && o.end - o.start == 2;
                !near.iter().any(|&(_, &(j, c, d))| {
                    j != i
                        && !own(&l.paths[j])
                        && !(same(c, a) || same(c, b) || same(d, a) || same(d, b))
                        && seg_dist(a, b, c, d) < JOIN_CLEAR_MM
                })
            })
            .collect();
        (keep, repeats)
    }

    #[test]
    fn walking_a_joins_cells_keeps_what_its_box_of_cells_kept() {
        // Long diagonal joins, each filed under many cells of the others' boxes, one long wall across them, and a short
        // wall beside each join, so some joins go and some stay.
        let mut seed = 7u64;
        let mut rand = |n: f64| {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            #[allow(clippy::cast_precision_loss, reason = "a test's pseudo random numbers")]
            let u = (seed >> 11) as f64 / (1u64 << 53) as f64;
            u * n
        };
        let mut l = LayerPaths::default();
        let add = |l: &mut LayerPaths, pts: &[(f64, f64)], feature: Feature| {
            let start = u32::try_from(l.points.len()).unwrap_or(0);
            l.points.extend(pts.iter().map(|&(x, y)| Point::from_mm(x, y)));
            l.paths.push(path(
                start,
                start + u32::try_from(pts.len()).unwrap_or(0),
                feature,
            ));
        };
        for k in 0..40 {
            let (a, b) = ((rand(30.0), rand(30.0)), (rand(30.0), rand(30.0)));
            add(&mut l, &[a, b], Feature::InternalSolid);
            l.joins.push([Point::from_mm(a.0, a.1), Point::from_mm(b.0, b.1)]);
            // A short wall beside the join at a random place along it, 0.03 mm off it (in reach) on every other join
            // and 0.08 mm (clear) on the rest. It is filed under few cells, so a cell the walk skips loses it.
            let len = crate::fm::Fm::m_hypot(b.0 - a.0, b.1 - a.1).max(1e-3);
            let off = if k % 2 == 0 { 0.03 } else { 0.08 };
            let (nx, ny) = (-(b.1 - a.1) / len * off, (b.0 - a.0) / len * off);
            let t = rand(1.0);
            let at = |t: f64| (a.0 + (b.0 - a.0) * t + nx, a.1 + (b.1 - a.1) * t + ny);
            add(&mut l, &[at(t), at(t + 0.01 / len)], Feature::InnerWall);
        }
        let pts: Vec<(f64, f64)> = (0..4).map(|_| (rand(30.0), rand(30.0))).collect();
        add(&mut l, &pts, Feature::OuterWall);
        // Joins along a cell edge with a wall in reach across it, in the next row or column of cells.
        for (a, b, w) in [
            ((40.0, 5.98), (50.0, 5.98), [(44.0, 6.01), (44.01, 6.01)]),
            ((45.98, 10.0), (45.98, 20.0), [(46.01, 14.0), (46.01, 14.01)]),
        ] {
            add(&mut l, &[a, b], Feature::InternalSolid);
            l.joins.push([Point::from_mm(a.0, a.1), Point::from_mm(b.0, b.1)]);
            add(&mut l, &w, Feature::InnerWall);
        }
        let (old, repeats) = box_keep(&l);
        assert!(repeats > 1000, "the box read segments again and again: {repeats}");
        let dropped = old.iter().filter(|k| !**k).count();
        assert!(dropped > 3 && dropped < 39, "{dropped} of 42 joins go");
        assert_eq!(crossing_keep(&l), Some(old));
    }

    #[test]
    fn segments_cross_only_through_each_other() {
        assert!(cross([0.0, 0.0], [2.0, 2.0], [0.0, 2.0], [2.0, 0.0]));
        assert!(!cross([0.0, 0.0], [1.0, 1.0], [1.0, 1.0], [2.0, 0.0]));
        assert!(!cross([0.0, 0.0], [2.0, 0.0], [0.0, 0.4], [2.0, 0.4]));
    }

    #[test]
    fn a_move_through_a_keep_out_zone_is_found_though_its_ends_lie_clear() {
        // The tower stroke runs from y 40 to 90 at x 150: through a 4 mm zone around y 62, with both ends outside it.
        let out = layer((5.0, 5.0), (100.0, 50.0), [(150.0, 40.0), (150.0, 90.0)]);
        let zone = |x0: f64, x1: f64| {
            vec![(
                ZONE_EXCLUSION,
                vec![[x0, 60.0], [x1, 60.0], [x1, 64.0], [x0, 64.0]],
            )]
        };
        let hits = check(&out, &zone(148.0, 152.0), false, 0.4, None);
        assert_eq!(hits.0.iter().map(|h| h.kind).collect::<Vec<_>>(), [Kind::KeepOut]);
        // Running along the zone's edge, within the contact tolerance, is not a hit.
        assert!(check(&out, &zone(149.97, 154.0), false, 0.4, None).0.is_empty());
    }
}
