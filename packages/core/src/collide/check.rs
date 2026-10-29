// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! heimdall's plate check before a slice: what a by-object plate would be refused for, worked out from each object's
//! footprint instead of its sliced moves. The obstacles, the walk and the report are the slice's own ([`super::Model`],
//! [`super::walk`], [`super::report`]); only the moves fed to the walk are made here.
//!
//! Each object's print layers, from its own session, are grouped into bands of [`BAND_MM`] (the first layer on its
//! own). For each band the walk runs one closed loop: the convex hull of the object's mesh from the layer below the
//! band to the band's top, grown by what prints round it there (brim, skirt, support, fuzzy skin), probed at the
//! band's lowest nozzle height. Every move a layer of the band prints lies inside that loop and no lower, so a move
//! the loop does not meet meets nothing, apart from three things the loop handles on its own:
//! - a head column off to the side of the nozzle (a fan duct) reaches from an inner move where no loop move takes
//!   it: the loop walks a copy of the head with every column stretched to cover the nozzle ([`super::Model::stretch`]);
//! - ground inside the loop itself (a part standing in a ring): where another object's footprint meets the loop, the
//!   loop's inside is probed row by row as well;
//! - what only the slice knows (tree support branches, tool change trips, a raft, painted brim ears): each object it
//!   applies to is listed as [`Unchecked`], never passed silently.
//!
//! A hit the loop finds is [`Certainty::Sure`] when a second walk with the real head, along only the part of the loop
//! that lies on the object's own first layer of the band, still finds it at least [`SURE_MM`] deep; else the slice
//! decides.

use super::report::{Collision, CollisionFix};
use super::{Hits, Model, Part, Severity, walk};
use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::output::{Feature, LayerPaths, PathInfo};
use crate::plate::PlateObject;
use crate::session::SliceSession;
use serde::{Deserialize, Serialize};

/// How much height one probed band of layers covers, mm.
pub(crate) const BAND_MM: f64 = 1.0;
/// How deep a hit found by the real head on the object's own outline must go to be sure, mm: one cell of the height
/// grids, more than the half line width the outer wall is set in from the outline.
pub(crate) const SURE_MM: f32 = 1.0;
/// How far round a point of the outline the object's own material is looked for, mm.
const ON_MATERIAL_MM: f64 = 0.5;
/// Sides of the circle a hull is grown by at each corner.
const GROW_SIDES: u32 = 16;

/// Whether the slice is sure to refuse for a collision the check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Certainty {
    /// The real head meets it from the object's own outline: the slice refuses the plate for it.
    Sure,
    /// It may be the outline's hull, a stretched head column or a brim, skirt or support rule: the slice decides.
    SliceDecides,
}

/// What the check leaves to the slice for one object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UncheckedKind {
    /// Tree support, whose branches can land outside the object's footprint.
    TreeSupport,
    /// Tool changes: where in a layer they happen, and the trips they make, only the slice knows.
    ToolChangeTrips,
    /// A raft under the object.
    Raft,
    /// Brim ears, automatic or painted, which the brim rule does not size.
    PaintedBrim,
}

/// One object's [`UncheckedKind`], with the objects close enough for it to matter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unchecked {
    pub object_id: String,
    pub what: UncheckedKind,
    /// The objects whose footprints come within the clearance radius of what this one prints round itself.
    pub near: Vec<String>,
}

/// What the check finds on a plate (`sx check`, [`crate::api::check_plate`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateCheck {
    /// As the slice reports them: the same kinds, fields and order.
    pub collisions: Vec<Collision>,
    /// The fixes, as the slice reports them.
    #[serde(rename = "collisionFixes")]
    pub fixes: Vec<CollisionFix>,
    /// One per collision: hits that are sure, and the rest.
    pub certainty: Vec<Certainty>,
    pub unchecked: Vec<Unchecked>,
    /// The object ids in the print order checked.
    pub order: Vec<String>,
    /// How long the check took, microseconds.
    pub micros: u64,
}

impl PlateCheck {
    /// A hit the slice is sure to refuse the plate for.
    pub fn has_sure(&self) -> bool {
        self.collisions
            .iter()
            .zip(&self.certainty)
            .any(|(c, s)| c.severity == Severity::Hit && *s == Certainty::Sure)
    }

    /// Nothing found and nothing left to the slice: a slice of the plate is not refused for the machine.
    pub fn is_clean(&self) -> bool {
        self.unchecked.is_empty() && !self.collisions.iter().any(|c| c.severity == Severity::Hit)
    }
}

/// A run of print layers the check probes as one, with its footprint.
#[derive(Debug, Clone, Default)]
struct Band {
    /// The object's own print layer the band starts at.
    first: u32,
    /// The top of that layer and its thickness, mm.
    top: f64,
    height: f64,
    /// The hull of the object's mesh from the bottom of the layer below the band to the top of its last layer.
    hull: Vec<[f64; 2]>,
    /// What the check walks: the hull grown by what prints round it on these layers.
    walk: Vec<[f64; 2]>,
}

/// What the check reads of one object of the plate.
struct Object<'a> {
    sub: &'a SliceSession,
    cfg: PrintConfig,
    /// Its first layer's index on the plate, and the top of the objects printed before it, mm.
    offset: u32,
    below_top: f64,
    /// How far its brim reaches past its first layer, mm.
    brim: f64,
    /// Its filament slots, each once, in plan order.
    slots: Vec<u8>,
}

/// The check of the by-object plate of `session`, whose collision model is `model` (as the slice builds it), with the
/// run's settings `config`. The collisions are empty where the slice has no model to walk (a plate printed layer by
/// layer, or with fewer than two objects), as its report is.
pub(crate) fn run(
    session: &SliceSession,
    mut model: Model,
    config: &PrintConfig,
) -> crate::error::Result<PlateCheck> {
    let stretched = model.stretch();
    let lift = super::lifts_over_print(config);
    let mut objects = Vec::new();
    let (mut offset, mut below_top) = (0u32, 0.0f64);
    for (k, sub) in session.sequence().enumerate() {
        let cfg = session.object_config(k, config)?;
        let brim = match crate::brim::Kind::of(&cfg) {
            crate::brim::Kind::Off => 0.0,
            crate::brim::Kind::Auto => sub.auto_brim_room(&cfg).unwrap_or(0.0),
            _ => cfg.brim_width.max(0.0),
        };
        let mut slots = Vec::new();
        for s in sub.own_slots() {
            if !slots.contains(&s) {
                slots.push(s);
            }
        }
        objects.push(Object {
            sub,
            cfg,
            offset,
            below_top,
            brim,
            slots,
        });
        offset += sub.plan_count();
        below_top = below_top.max(sub.plate_top());
    }
    let model = &model;
    let n = objects.len().min(model.objects.len());
    let kept = objects.get(..n).unwrap_or_default();
    let indexed: Vec<(usize, &Object<'_>)> = kept.iter().enumerate().collect();
    let bands = crate::par::map(&indexed, |&(k, o)| bands_of(model, k, o));
    let walked = crate::par::map(&indexed, |&(k, o)| {
        let layers = loops(model, k, o, bands.get(k).map_or(&[][..], Vec::as_slice));
        walk::object_layers_with(model, k, &layers, o.cfg.travel_speed, lift, stretched, None)
    });
    let mut hits = Hits::default();
    for h in &walked {
        hits.merge(h.clone());
    }
    // The real head on the objects' own outlines, on the layers where the loops hit an object the report keeps: the
    // loops reach everywhere the real head does on the outline, so it can hit nowhere else.
    let strict = crate::par::map(&indexed, |&(k, o)| {
        let reported: Vec<&super::Hit> = walked.get(k).map_or(Vec::new(), |h| {
            h.0.iter()
                .filter(|h| h.severity == Severity::Hit && (h.obstacle as usize) < k)
                .collect()
        });
        let spans: Vec<[u32; 2]> = reported.iter().map(|h| [h.first.layer, h.last_layer]).collect();
        let mut only: Vec<usize> = reported.iter().map(|h| h.obstacle as usize).collect();
        only.sort_unstable();
        only.dedup();
        if spans.is_empty() {
            return Hits::default();
        }
        let hit: Vec<Band> = bands
            .get(k)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter(|b| {
                let at = o.offset + b.first;
                spans.iter().any(|s| s[0] <= at && at <= s[1])
            })
            .cloned()
            .collect();
        let layers = outlines(model, k, o, &hit);
        walk::object_layers_with(model, k, &layers, o.cfg.travel_speed, lift, 0, Some(&only))
    });
    let meta = model.meta.clone().with_run(config);
    let report = super::report(&meta, &hits.0, &[], 0.0);
    let index_of = |id: &str| meta.objects.iter().position(|o| o.id == id);
    let mut certainty = Vec::with_capacity(report.collisions.len());
    for c in &report.collisions {
        let sure = c.severity == Severity::Hit
            && index_of(&c.object_id)
                .zip(index_of(&c.hit_id))
                .is_some_and(|(k, j)| strict.get(k).is_some_and(|s| sure_in(s, c.part, j)));
        certainty.push(if sure {
            Certainty::Sure
        } else {
            Certainty::SliceDecides
        });
    }
    Ok(PlateCheck {
        collisions: report.collisions,
        fixes: report.fixes,
        certainty,
        unchecked: unchecked(model, kept),
        order: meta.objects.iter().map(|o| o.id.clone()).collect(),
        micros: 0,
    })
}

/// Whether the real head's walk `strict` meets object `j` with `part` deep enough to be sure, on more than one probe.
fn sure_in(strict: &Hits, part: Part, j: usize) -> bool {
    let need = match part {
        Part::Gantry | Part::Lid => super::EPS,
        _ => SURE_MM,
    };
    strict.0.iter().any(|h| {
        h.severity == Severity::Hit
            && h.part == part
            && h.obstacle as usize == j
            && h.depth >= need
            && h.moves >= 2
    })
}

/// The heads an object's filaments print with, as one slot of each.
fn head_slots(model: &Model, o: &Object<'_>) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut seen = Vec::new();
    for &s in &o.slots {
        let h = model.head(s);
        if !seen.contains(&h) {
            seen.push(h);
            out.push(s);
        }
    }
    if out.is_empty() {
        out.push(1);
    }
    out
}

/// Whether some of the object's moves can print below their layer's top: a spiral vase climbs from a layer lower, and
/// a scarf seam starts below it.
fn prints_below_top(cfg: &PrintConfig) -> bool {
    crate::spiral::enabled(cfg)
        || matches!(cfg.raw.get("seam_slope_type"), Some(serde_json::Value::String(t)) if t != "none")
}

/// How far the moves of every layer print past the mesh's outline, mm: fuzzy skin and a positive XY contour
/// compensation.
fn outward(cfg: &PrintConfig, obj: &PlateObject) -> f64 {
    let fuzzy = matches!(cfg.raw.get("fuzzy_skin"), Some(serde_json::Value::String(t)) if t != "none")
        || obj.mesh.parts.iter().any(|p| !p.fuzzy_paint.is_empty());
    let fuzz = if fuzzy {
        cfg.raw_number("fuzzy_skin_thickness", 0.3).max(0.0)
    } else {
        0.0
    };
    fuzz + cfg.raw_number("xy_contour_compensation", 0.0).max(0.0)
}

/// How far support prints past the part it holds up, mm: the support term of the first layer's reach, which is wider
/// than any layer above prints it.
fn support_reach(cfg: &PrintConfig) -> f64 {
    let mut bare = cfg.clone();
    bare.skirt_loops = 0;
    crate::tower::room_with(&bare, 0.0)
}

fn support_on(o: &Object<'_>) -> bool {
    super::rules::support_runs(o.cfg.enable_support, o.cfg.support.manual, o.sub.enforced())
}

fn draft_shield(cfg: &PrintConfig) -> bool {
    matches!(cfg.raw.get("draft_shield"), Some(serde_json::Value::String(t)) if t == "enabled")
}

/// The bands of object `k` of `model`, printed as `o`.
fn bands_of(model: &Model, k: usize, o: &Object<'_>) -> Vec<Band> {
    let Some(ob) = model.objects.get(k) else {
        return Vec::new();
    };
    let tops = o.sub.print_tops();
    let bottom = |i: usize| i.checked_sub(1).and_then(|p| tops.get(p)).copied().unwrap_or(0.0);
    let skirt_end = if draft_shield(&o.cfg) {
        usize::MAX
    } else if o.cfg.skirt_loops > 0 {
        o.cfg.skirt_height as usize
    } else {
        0
    };
    // The first layer alone, then runs of at most BAND_MM, split where the skirt ends.
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut s = 0usize;
    while s < tops.len() {
        let mut e = s;
        while s > 0
            && e + 1 < tops.len()
            && e + 1 != skirt_end
            && tops.get(e + 1).is_some_and(|&t| t - bottom(s) <= BAND_MM)
        {
            e += 1;
        }
        spans.push((s, e));
        s = e + 1;
    }
    // Each band holds the mesh from the bottom of the layer below it (where its first move comes from) to its top.
    let ranges: Vec<[f64; 2]> = spans
        .iter()
        .map(|&(s, e)| [bottom(s.saturating_sub(1)), tops.get(e).copied().unwrap_or(0.0)])
        .collect();
    let footprint = &ob.hull;
    let raft = o.sub.has_raft();
    let hulls: Vec<Vec<[f64; 2]>> = if raft {
        // A raft lifts the part's layers off its mesh: every band holds the whole footprint.
        vec![footprint.clone(); spans.len()]
    } else {
        band_hulls(&ob.object, &ranges)
    };
    // Support under what is above: the hull of everything from the band up, grown by the support's reach.
    let mut walks = hulls.clone();
    if support_on(o) {
        let reach = support_reach(&o.cfg);
        let mut above: Vec<[f64; 2]> = Vec::new();
        for (h, w) in hulls.iter().zip(walks.iter_mut()).rev() {
            let mut pts = above;
            pts.extend_from_slice(h);
            above = convex_hull(pts);
            let mut all = grow(&above, reach);
            all.extend_from_slice(w);
            *w = convex_hull(all);
        }
    }
    let extra = outward(&o.cfg, &ob.object);
    let first = super::rules::object_room_around(&o.cfg, o.brim, footprint);
    let skirt = super::rules::object_room_around(&o.cfg, 0.0, footprint);
    let raft_room = if raft {
        first + o.cfg.raw_number("raft_first_layer_expansion", 2.0).max(0.0)
    } else {
        0.0
    };
    let mut out = Vec::with_capacity(spans.len());
    for (b, (((s, _), w), hull)) in spans.iter().zip(walks).zip(hulls).enumerate() {
        let by = if raft {
            raft_room
        } else if b == 0 {
            first
        } else if *s < skirt_end {
            skirt
        } else {
            0.0
        };
        let top = tops.get(*s).copied().unwrap_or(0.0);
        out.push(Band {
            first: u32::try_from(*s).unwrap_or(u32::MAX),
            top,
            height: (top - bottom(*s)).max(0.0),
            hull,
            walk: grow(&w, by + extra),
        });
    }
    out
}

/// The convex hull of `obj`'s mesh between each of `ranges` (`[from, to]` z, mm; ascending, neighbors may overlap).
fn band_hulls(obj: &PlateObject, ranges: &[[f64; 2]]) -> Vec<Vec<[f64; 2]>> {
    /// Points a band gathers before they are cut back to their hull.
    const KEEP: usize = 4096;
    let mut pts: Vec<Vec<[f64; 2]>> = vec![Vec::new(); ranges.len()];
    let push = |pts: &mut Vec<Vec<[f64; 2]>>, b: usize, p: [f64; 2]| {
        if let Some(v) = pts.get_mut(b) {
            v.push(p);
            if v.len() > KEEP {
                *v = convex_hull(std::mem::take(v));
            }
        }
    };
    for part in &obj.mesh.parts {
        let placed: Vec<[f64; 3]> = part.positions.iter().map(|&v| obj.apply(v)).collect();
        for t in &part.triangles {
            let (Some(&a), Some(&b), Some(&c)) = (
                placed.get(t[0] as usize),
                placed.get(t[1] as usize),
                placed.get(t[2] as usize),
            ) else {
                continue;
            };
            let lo = a[2].min(b[2]).min(c[2]);
            let hi = a[2].max(b[2]).max(c[2]);
            let start = ranges.partition_point(|r| r[1] < lo);
            for (i, r) in ranges.iter().enumerate().skip(start) {
                if r[0] > hi {
                    break;
                }
                if lo >= r[0] && hi <= r[1] {
                    for q in [a, b, c] {
                        push(&mut pts, i, [q[0], q[1]]);
                    }
                } else {
                    slab_points(&[a, b, c], r[0], r[1], &mut |q| push(&mut pts, i, q));
                }
            }
        }
    }
    pts.into_iter().map(convex_hull).collect()
}

/// The corners of a triangle clipped to `lo <= z <= hi`, as points on the bed (some more than once): its own corners
/// in that height, and where its edges cross either bound.
fn slab_points(t: &[[f64; 3]; 3], lo: f64, hi: f64, out: &mut dyn FnMut([f64; 2])) {
    for (i, p) in t.iter().enumerate() {
        if p[2] >= lo && p[2] <= hi {
            out([p[0], p[1]]);
        }
        let Some(q) = t.get((i + 1) % 3) else {
            continue;
        };
        for z in [lo, hi] {
            if (p[2] - z) * (q[2] - z) < 0.0 {
                let s = (z - p[2]) / (q[2] - p[2]);
                out([p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1])]);
            }
        }
    }
}

/// The convex hull of `pts`, counterclockwise, without repeated or collinear points.
pub(crate) fn convex_hull(mut pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let cross =
        |o: [f64; 2], a: [f64; 2], b: [f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut lower: Vec<[f64; 2]> = Vec::new();
    for &p in &pts {
        while let [.., a, b] = lower.as_slice()
            && cross(*a, *b, p) <= 0.0
        {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<[f64; 2]> = Vec::new();
    for &p in pts.iter().rev() {
        while let [.., a, b] = upper.as_slice()
            && cross(*a, *b, p) <= 0.0
        {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// A convex hull grown by `r` mm all round: its corners' circles, drawn round the circle so no point is short of it.
pub(crate) fn grow(hull: &[[f64; 2]], r: f64) -> Vec<[f64; 2]> {
    if r <= 0.0 || hull.is_empty() {
        return hull.to_vec();
    }
    let step = std::f64::consts::TAU / f64::from(GROW_SIDES);
    let out_r = r / (0.5 * step).m_cos();
    let mut pts = Vec::with_capacity(hull.len() * GROW_SIDES as usize);
    for p in hull {
        for i in 0..GROW_SIDES {
            let a = step * f64::from(i);
            pts.push([p[0] + out_r * a.m_cos(), p[1] + out_r * a.m_sin()]);
        }
    }
    convex_hull(pts)
}

/// Whether two convex hulls share any ground.
fn overlap(a: &[[f64; 2]], b: &[[f64; 2]]) -> bool {
    let bbox = |h: &[[f64; 2]]| {
        h.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |r, p| {
            [r[0].min(p[0]), r[1].min(p[1]), r[2].max(p[0]), r[3].max(p[1])]
        })
    };
    let (ba, bb) = (bbox(a), bbox(b));
    if a.is_empty() || b.is_empty() || ba[0] > bb[2] || bb[0] > ba[2] || ba[1] > bb[3] || bb[1] > ba[3] {
        return false;
    }
    if a.iter().any(|p| walk::hull_distance(b, *p) <= 0.0)
        || b.iter().any(|p| walk::hull_distance(a, *p) <= 0.0)
    {
        return true;
    }
    let orient =
        |p: [f64; 2], q: [f64; 2], r: [f64; 2]| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    let edges = |h: &[[f64; 2]]| -> Vec<([f64; 2], [f64; 2])> {
        h.iter()
            .zip(h.iter().cycle().skip(1))
            .map(|(p, q)| (*p, *q))
            .collect()
    };
    let eb = edges(b);
    edges(a).iter().any(|&(p1, p2)| {
        eb.iter().any(|&(q1, q2)| {
            orient(p1, p2, q1) * orient(p1, p2, q2) < 0.0 && orient(q1, q2, p1) * orient(q1, q2, p2) < 0.0
        })
    })
}

/// The gap between two convex hulls, mm; 0 where they share ground.
fn gap(a: &[[f64; 2]], b: &[[f64; 2]]) -> f64 {
    if overlap(a, b) {
        return 0.0;
    }
    let one = |from: &[[f64; 2]], to: &[[f64; 2]]| {
        from.iter()
            .map(|p| walk::hull_distance(to, *p))
            .fold(f64::INFINITY, f64::min)
    };
    one(a, b).min(one(b, a))
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "bed positions in mm, a few hundred across"
)]
fn point(p: [f64; 2]) -> Point {
    Point {
        x: (p[0] * SCALE).round() as i32,
        y: (p[1] * SCALE).round() as i32,
    }
}

/// One layer of the walk, as the slice writes them: `paths` as point lists, each printed with `tool`.
#[allow(
    clippy::cast_possible_truncation,
    reason = "heights in mm, as the preview keeps them"
)]
fn layer(o: &Object<'_>, b: &Band, z: f64, tool: u8, paths: &[Vec<[f64; 2]>]) -> LayerPaths {
    let mut l = LayerPaths {
        index: o.offset + b.first,
        local: b.first,
        below_top: if o.offset > 0 { o.below_top as f32 } else { 0.0 },
        z: z as f32,
        height: b.height as f32,
        start_tool: tool,
        ..LayerPaths::default()
    };
    for p in paths {
        let start = u32::try_from(l.points.len()).unwrap_or(u32::MAX);
        l.points.extend(p.iter().map(|q| point(*q)));
        let end = u32::try_from(l.points.len()).unwrap_or(u32::MAX);
        l.paths.push(PathInfo {
            start,
            end,
            tool,
            feature: Feature::OuterWall,
            speed_mm_s: 100.0,
            width_mm: 0.4,
            flow: 1.0,
            dz: 0.0,
            overhang_fan: false,
            owner: 0,
            tower_wipe: false,
            tower_hop: false,
            slow_span: false,
        });
    }
    l
}

/// The moves the check walks for object `k`: per band and head, its loop at the band's lowest nozzle height, and the
/// loop's inside in rows of one cell where another object's footprint reaches into it.
fn loops(model: &Model, k: usize, o: &Object<'_>, bands: &[Band]) -> Vec<LayerPaths> {
    let low = prints_below_top(&o.cfg);
    let reach = model.reach();
    let tools = head_slots(model, o);
    let mut out = Vec::new();
    for b in bands.iter().filter(|b| b.walk.len() >= 2) {
        let mut paths = vec![closed(&b.walk)];
        for (j, other) in model.objects.iter().enumerate() {
            if j != k && overlap(&b.walk, &other.hull) {
                let e = other.extent;
                paths.extend(rows(
                    &b.walk,
                    [e[0] - reach, e[1] - reach, e[2] + reach, e[3] + reach],
                ));
            }
        }
        let z = if low { b.top - b.height } else { b.top };
        for &t in &tools {
            out.push(layer(o, b, z, t, &paths));
        }
    }
    out
}

/// The hull as a closed loop.
fn closed(h: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut v = h.to_vec();
    if let Some(&p) = h.first() {
        v.push(p);
    }
    v
}

/// The inside of the convex `hull` within the box `[min x, min y, max x, max y]`, as one move per row of cells.
fn rows(hull: &[[f64; 2]], area: [f64; 4]) -> Vec<Vec<[f64; 2]>> {
    let (lo, hi) = hull
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p[1]), hi.max(p[1])));
    let (y0, y1) = (lo.max(area[1]), hi.min(area[3]));
    let mut out = Vec::new();
    let mut y = y0;
    while y <= y1 {
        // Where the row crosses the hull's edges.
        let mut xs = (f64::MAX, f64::MIN);
        for (p, q) in hull.iter().zip(hull.iter().cycle().skip(1)) {
            if (p[1] - y) * (q[1] - y) <= 0.0 && (p[1] - q[1]).abs() > 1e-12 {
                let x = p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0]);
                xs = (xs.0.min(x), xs.1.max(x));
            } else if (p[1] - y).abs() <= 1e-12 {
                xs = (xs.0.min(p[0]), xs.1.max(p[0]));
            }
        }
        let (x0, x1) = (xs.0.max(area[0]), xs.1.min(area[2]));
        if x0 <= x1 {
            out.push(vec![[x0, y], [x1, y]]);
        }
        y += super::grid::CELL;
    }
    out
}

/// The moves of the real head's walk for object `k`: per band and head, the runs of its hull (sampled every cell)
/// that lie on the object's own material in the band's first layer, at that layer's top.
fn outlines(model: &Model, k: usize, o: &Object<'_>, bands: &[Band]) -> Vec<LayerPaths> {
    let Some(ob) = model.objects.get(k) else {
        return Vec::new();
    };
    let surface = ob.surface();
    let tools = head_slots(model, o);
    let mut out = Vec::new();
    for b in bands.iter().filter(|b| b.hull.len() >= 2) {
        let (lo, hi) = (b.top - b.height, b.top);
        let on = |p: [f64; 2]| {
            let r = ON_MATERIAL_MM;
            super::grid::material_in(surface, [p[0] - r, p[0] + r, p[1] - r, p[1] + r], lo, hi, p)
        };
        let mut runs: Vec<Vec<[f64; 2]>> = Vec::new();
        let mut run: Vec<[f64; 2]> = Vec::new();
        for p in samples(&b.hull) {
            if on(p) {
                run.push(p);
            } else if !run.is_empty() {
                runs.push(std::mem::take(&mut run));
            }
        }
        if !run.is_empty() {
            runs.push(run);
        }
        for r in &mut runs {
            if let [p] = r.as_slice() {
                let p = *p;
                r.push(p);
            }
        }
        for r in &runs {
            for &t in &tools {
                out.push(layer(o, b, b.top, t, std::slice::from_ref(r)));
            }
        }
    }
    out
}

/// Points round the closed `hull` at most a cell apart, its corners among them.
fn samples(hull: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    for (p, q) in hull.iter().zip(hull.iter().cycle().skip(1)) {
        let len = (q[0] - p[0]).m_hypot(q[1] - p[1]);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "steps along an edge a few hundred mm long"
        )]
        let n = (len / super::grid::CELL).ceil().max(1.0) as u32;
        for i in 0..n {
            let s = f64::from(i) / f64::from(n);
            out.push([p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1])]);
        }
    }
    out
}

/// What the check leaves to the slice, per object in print order.
fn unchecked(model: &Model, objects: &[Object<'_>]) -> Vec<Unchecked> {
    let changer = model.changer.is_some();
    let mut out = Vec::new();
    for (k, o) in objects.iter().enumerate() {
        let Some(ob) = model.objects.get(k) else {
            continue;
        };
        let mut what = Vec::new();
        if support_on(o) && (o.cfg.support.style.is_tree() || o.cfg.support.tree) {
            what.push(UncheckedKind::TreeSupport);
        }
        // Changes within the object, and on a tool changer the change into it from the object before.
        let before = k.checked_sub(1).and_then(|p| objects.get(p));
        if o.slots.len() > 1 || (changer && before.is_some_and(|b| b.slots != o.slots)) {
            what.push(UncheckedKind::ToolChangeTrips);
        }
        if o.sub.has_raft() {
            what.push(UncheckedKind::Raft);
        }
        if matches!(
            crate::brim::Kind::of(&o.cfg),
            crate::brim::Kind::Ears | crate::brim::Kind::Painted
        ) {
            what.push(UncheckedKind::PaintedBrim);
        }
        if what.is_empty() {
            continue;
        }
        let room = super::rules::object_room_around(&o.cfg, o.brim, &ob.hull);
        let near: Vec<String> = model
            .objects
            .iter()
            .enumerate()
            .filter(|&(j, other)| j != k && gap(&ob.hull, &other.hull) < model.radius + room)
            .filter_map(|(j, _)| model.meta.objects.get(j).map(|m| m.id.clone()))
            .collect();
        for w in what {
            out.push(Unchecked {
                object_id: ob.object.id.clone(),
                what: w,
                near: near.clone(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hull_is_counterclockwise_and_drops_inner_and_collinear_points() {
        let h = convex_hull(vec![
            [0.0, 0.0],
            [5.0, 0.0],
            [10.0, 0.0],
            [10.0, 10.0],
            [5.0, 5.0],
            [0.0, 10.0],
            [0.0, 0.0],
        ]);
        assert_eq!(h, vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]);
    }

    #[test]
    fn a_grown_hull_is_never_short_of_the_distance() {
        let sq = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let g = grow(&sq, 5.0);
        // every direction out of the square reaches at least 5 mm
        for i in 0..360 {
            let a = f64::from(i).to_radians();
            let p = [5.0 + 9.99 * a.m_cos(), 5.0 + 9.99 * a.m_sin()];
            let edge = [p[0].clamp(0.0, 10.0), p[1].clamp(0.0, 10.0)];
            let d = (p[0] - edge[0]).m_hypot(p[1] - edge[1]);
            if d < 4.99 {
                assert!(walk::hull_distance(&g, p) <= 0.0, "{p:?} at {d} mm");
            }
        }
        assert!(walk::hull_distance(&g, [15.6, 5.0]) > 0.0);
    }

    #[test]
    fn a_band_holds_the_mesh_between_its_heights() {
        // A cone, 60 mm across at the base and 6 at the top 30 mm up, as a fan of triangles.
        let mut positions = vec![[0.0f32, 0.0, 30.0]];
        for i in 0..32 {
            let a = std::f64::consts::TAU * f64::from(i) / 32.0;
            #[allow(clippy::cast_possible_truncation, reason = "a test shape")]
            positions.push([(30.0 * a.m_cos()) as f32, (30.0 * a.m_sin()) as f32, 0.0]);
        }
        let mut triangles = Vec::new();
        for i in 1..=32u32 {
            triangles.push([0, i, i % 32 + 1]);
        }
        let mesh = std::sync::Arc::new(crate::mesh::Mesh {
            name: "cone".into(),
            parts: vec![crate::mesh::MeshPart {
                name: "cone".into(),
                slot: 1,
                color: None,
                positions,
                triangles,
                paint: Vec::new(),
                support_paint: Vec::new(),
                seam_paint: Vec::new(),
                fuzzy_paint: Vec::new(),
                paint_texts: Vec::new(),
            }],
            ..crate::mesh::Mesh::default()
        });
        let obj = PlateObject {
            id: "cone".into(),
            name: "cone".into(),
            mesh,
            transform: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 100.0, 100.0, 0.0, 1.0,
            ],
            slot_overrides: Vec::new(),
            part_settings: Vec::new(),
            volumes: Vec::new(),
            brim_points: Vec::new(),
            settings: serde_json::Value::Null,
        };
        let h = band_hulls(&obj, &[[0.0, 1.0], [15.0, 16.0], [29.0, 30.0]]);
        let width = |h: &[[f64; 2]]| {
            h.iter().map(|p| p[0]).fold(f64::MIN, f64::max) - h.iter().map(|p| p[0]).fold(f64::MAX, f64::min)
        };
        // The base band is the base; halfway up it is half as wide (with its lower edge); at the top a point.
        assert!((width(&h[0]) - 60.0).abs() < 0.2, "{}", width(&h[0]));
        assert!((width(&h[1]) - 30.0).abs() < 0.2, "{}", width(&h[1]));
        assert!(width(&h[2]) < 2.1, "{}", width(&h[2]));
    }

    #[test]
    fn the_rows_fill_the_hull_inside_the_area_only() {
        let sq = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let r = rows(&sq, [2.0, 3.0, 20.0, 5.5]);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0], vec![[2.0, 3.0], [10.0, 3.0]]);
        assert!(rows(&sq, [20.0, 0.0, 30.0, 10.0]).is_empty());
    }

    #[test]
    fn hulls_that_share_ground_overlap_and_their_gap_is_zero() {
        let a = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let cross = [[4.0, -5.0], [6.0, -5.0], [6.0, 15.0], [4.0, 15.0]];
        assert!(overlap(&a, &cross));
        let far = [[13.0, 0.0], [20.0, 0.0], [20.0, 10.0], [13.0, 10.0]];
        assert!(!overlap(&a, &far));
        assert!((gap(&a, &far) - 3.0).abs() < 1e-9);
        assert!(gap(&a, &cross).abs() < 1e-12);
    }
}
