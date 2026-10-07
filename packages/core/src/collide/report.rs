// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What the app shows: the collisions the plate's order runs into, when each happens, and the fixes with their cost.
//! Codes, numbers and object ids only; the app writes the words.

use super::{Hit, Kind, Meta, Part, Severity};
use serde::{Deserialize, Serialize};

/// A collision of the print as the slice result reports it (`Collision` in the contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collision {
    pub kind: Kind,
    pub severity: Severity,
    pub part: Part,
    /// The object printing, and the one it meets.
    pub object_id: String,
    pub hit_id: String,
    /// When it first happens: the plate layer (0-based), the move in it as the preview counts them, the print time.
    pub layer: u32,
    pub segment: u32,
    pub time_s: f64,
    /// The last layer it happens on.
    pub last_layer: u32,
    /// The nozzle tip and where the machine meets the part at that moment, mm.
    pub at: [f32; 3],
    pub point: [f32; 3],
    /// Where it goes deepest.
    pub worst_layer: u32,
    pub worst_point: [f32; 3],
    pub depth_mm: f32,
    /// How tall the object it meets stands, mm.
    pub hit_height_mm: f32,
    /// The clearance it breaks, mm: the rod height (gantry), the lid height (lid), the clearance radius (close call);
    /// 0 for the rest.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub limit_mm: f32,
    /// The extra spacing that clears it sideways (toolhead), mm.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub push_mm: f32,
    /// During a tool change: the tools (0-based) and how far along the trip, 0 to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<(u8, u8, f32)>,
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's skip_serializing_if signature"
)]
fn is_zero(v: &f32) -> bool {
    *v == 0.0
}

/// What a fix does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixKind {
    /// Print the objects in another order.
    Reorder,
    /// Print by layer instead of by object.
    ByLayer,
    /// Place the objects further apart.
    Spread,
    /// Lift the nozzle higher on travels.
    RaiseLift,
    /// Move one object out of the tool changer's way, or out of a keep-out zone.
    MoveObject,
    /// Arrange the plate again, so no paths cross.
    Arrange,
}

/// A fix for some of the collisions (`CollisionFix` in the contract).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollisionFix {
    pub kind: FixKind,
    /// Print time it adds (negative when it saves), s.
    pub cost_s: f64,
    /// The collisions it clears, as indices into the list.
    pub clears: Vec<u32>,
    /// One click applies it safely (a new order, print by layer); the others are explained.
    pub one_click: bool,
    /// Reorder: the object ids in the new print order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<String>,
    /// Spread: the extra space between objects; raise lift: the Z hop, mm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mm: Option<f32>,
    /// Move object: which one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    /// Print by layer: the most extra travel moves on one layer.
    #[serde(default, skip_serializing_if = "is_none_u32")]
    pub moves: u32,
    /// Reorder: the close calls the new order still has (pairs inside the profile's radius the head itself clears).
    #[serde(default, skip_serializing_if = "is_none_u32")]
    pub close_calls: u32,
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's skip_serializing_if signature"
)]
fn is_none_u32(v: &u32) -> bool {
    *v == 0
}

/// The collisions and fixes of a plate.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub collisions: Vec<Collision>,
    pub fixes: Vec<CollisionFix>,
}

impl Report {
    pub fn is_empty(&self) -> bool {
        self.collisions.is_empty()
    }
}

/// When a moment happens: the start before the first layer, the layers before it and its share of its own layer.
fn time_of(layer_s: &[f64], prepare_s: f64, layer: u32, share: f32) -> f64 {
    let n = (layer as usize).min(layer_s.len());
    let mut t = prepare_s + f64::from(share) * layer_s.get(n).copied().unwrap_or(0.0);
    for s in layer_s.get(..n).unwrap_or(&[]) {
        t += s;
    }
    t
}

/// The report of `hits` (every object against every other) for the plate's order: each object meets only the ones
/// printed before it. `layer_s` are the layers' seconds and `prepare_s` the start before them, for the times.
pub fn report(meta: &Meta, hits: &[Hit], layer_s: &[f64], prepare_s: f64) -> Report {
    // Hits first; the profile's radius only where the head itself clears that pair.
    let mut kept: Vec<(f64, &Hit)> = Vec::new();
    for h in hits {
        // A crossing or a keep-out zone counts in any order; the machine meets only objects printed before.
        let any_order = matches!(h.kind, Kind::PathConflict | Kind::KeepOut);
        if (any_order || h.obstacle < h.mover) && h.severity == Severity::Hit {
            kept.push((time_of(layer_s, prepare_s, h.first.layer, h.first.share), h));
        }
    }
    for h in hits {
        let pair = |k: &(f64, &Hit)| k.1.mover == h.mover && k.1.obstacle == h.obstacle;
        if h.obstacle < h.mover && h.severity == Severity::Close && !kept.iter().any(pair) {
            kept.push((time_of(layer_s, prepare_s, h.first.layer, h.first.share), h));
        }
    }
    // Shards add their hits in any order: sorted by time, then by everything that tells two apart. Few enough for an
    // insertion sort.
    let key = |k: &(f64, &Hit)| (k.1.mover, k.1.obstacle, k.1.kind, k.1.severity, k.1.part);
    for i in 1..kept.len() {
        let mut j = i;
        while j > 0 {
            let (Some(a), Some(b)) = (kept.get(j - 1), kept.get(j)) else {
                break;
            };
            if a.0.total_cmp(&b.0).then(key(a).cmp(&key(b))).is_le() {
                break;
            }
            kept.swap(j - 1, j);
            j -= 1;
        }
    }
    let mut collisions = Vec::with_capacity(kept.len());
    for &(time_s, h) in &kept {
        let limit = match (h.severity, h.part) {
            (Severity::Close, _) => meta.radius,
            (_, Part::Gantry) => meta.rod,
            (_, Part::Lid) => meta.lid,
            _ => 0.0,
        };
        collisions.push(Collision {
            kind: h.kind,
            severity: h.severity,
            part: h.part,
            object_id: meta.id(h.mover),
            hit_id: meta.id(h.obstacle),
            layer: h.first.layer,
            segment: h.first.segment,
            time_s,
            last_layer: h.last_layer,
            at: h.first.at,
            point: h.first.point,
            worst_layer: h.worst.layer,
            worst_point: h.worst.point,
            depth_mm: h.depth,
            hit_height_mm: meta.objects.get(h.obstacle as usize).map_or(0.0, |o| o.height),
            limit_mm: limit,
            push_mm: h.push,
            change: h.first.change,
        });
    }
    let mut hits_kept = Vec::with_capacity(kept.len());
    for k in &kept {
        hits_kept.push(k.1);
    }
    let kept = hits_kept;
    let fixes = fixes(meta, hits, &kept, &collisions);
    Report { collisions, fixes }
}

impl Meta {
    /// An object's id; after the objects, the prime tower and the keep-out zones by kind.
    fn id(&self, i: u32) -> String {
        let n = self.objects.len();
        let i = i as usize;
        match self.objects.get(i) {
            Some(o) => o.id.clone(),
            None if i == n => "prime-tower".to_owned(),
            None => match self.zones.get(i.saturating_sub(n + 1)) {
                Some(&super::plate::ZONE_WRAP_CHECK) => "wrap-check-zone".to_owned(),
                _ => "exclusion-area".to_owned(),
            },
        }
    }
}

/// The order closest to the plate's own in which no object prints after one its moves meet: a topological order
/// that takes the earliest object it may, and when a cycle leaves none, the one with the fewest objects left that
/// must come before it.
fn order_without(n: usize, before: &[(usize, usize)]) -> Vec<usize> {
    let mut left: Vec<usize> = Vec::with_capacity(n);
    for i in 0..n {
        left.push(i);
    }
    let mut out = Vec::with_capacity(n);
    while !left.is_empty() {
        let mut pick = (usize::MAX, 0, 0);
        for (k, &i) in left.iter().enumerate() {
            let blockers = before
                .iter()
                .filter(|&&(a, b)| b == i && a != i && left.contains(&a))
                .count();
            if blockers < pick.0 {
                pick = (blockers, i, k);
            }
        }
        out.push(pick.1);
        left.remove(pick.2);
    }
    out
}

fn fix(kind: FixKind, cost_s: f64, clears: Vec<u32>, one_click: bool) -> CollisionFix {
    CollisionFix {
        kind,
        cost_s,
        clears,
        one_click,
        order: Vec::new(),
        mm: None,
        object_id: None,
        moves: 0,
        close_calls: 0,
    }
}

fn fixes(meta: &Meta, hits: &[Hit], kept: &[&Hit], collisions: &[Collision]) -> Vec<CollisionFix> {
    let mut out = Vec::new();
    let total = collisions.len();
    if total == 0 {
        return out;
    }
    let n = meta.objects.len();
    let machine = |k: Kind| !matches!(k, Kind::PathConflict | Kind::KeepOut);
    let index = |pred: &dyn Fn(&Collision) -> bool| -> Vec<u32> {
        let mut v = Vec::new();
        for (i, c) in collisions.iter().enumerate() {
            if pred(c) {
                v.push(u32::try_from(i).unwrap_or(u32::MAX));
            }
        }
        v
    };
    // A new order: every pair that meets, hit or close, wants the mover first; failing that, every pair that hits.
    let mut best: Option<(Vec<usize>, Vec<u32>)> = None;
    for with_close in [true, false] {
        let mut before = Vec::new();
        for h in hits.iter().filter(|h| machine(h.kind)) {
            if with_close || h.severity == Severity::Hit {
                before.push((h.mover as usize, h.obstacle as usize));
            }
        }
        let order = order_without(n, &before);
        if order.iter().copied().eq(0..n) {
            continue;
        }
        let mut pos = vec![0usize; n];
        for (k, &i) in order.iter().enumerate() {
            if let Some(p) = pos.get_mut(i) {
                *p = k;
            }
        }
        let at = |i: u32| pos.get(i as usize).copied().unwrap_or(0);
        let mut clears = Vec::new();
        for (i, h) in kept.iter().enumerate() {
            if machine(h.kind) && at(h.obstacle) > at(h.mover) {
                clears.push(u32::try_from(i).unwrap_or(u32::MAX));
            }
        }
        let new = hits.iter().any(|h| {
            machine(h.kind)
                && h.severity == Severity::Hit
                && h.obstacle > h.mover
                && at(h.obstacle) < at(h.mover)
        });
        if !new && !clears.is_empty() && best.as_ref().is_none_or(|(_, c)| clears.len() > c.len()) {
            best = Some((order, clears));
        }
    }
    if let Some((order, clears)) = best {
        let mut pos = vec![0usize; n];
        for (k, &i) in order.iter().enumerate() {
            if let Some(p) = pos.get_mut(i) {
                *p = k;
            }
        }
        let at = |i: u32| pos.get(i as usize).copied().unwrap_or(0);
        // The pairs still inside the radius in the new order: the mover prints after the object it passes.
        let mut close: Vec<(u32, u32)> = Vec::new();
        for h in hits {
            if machine(h.kind)
                && h.severity == Severity::Close
                && at(h.obstacle) < at(h.mover)
                && !close.contains(&(h.mover, h.obstacle))
            {
                close.push((h.mover, h.obstacle));
            }
        }
        let mut f = fix(FixKind::Reorder, 0.0, clears, true);
        f.close_calls = u32::try_from(close.len()).unwrap_or(u32::MAX);
        for &i in &order {
            f.order.push(meta.id(u32::try_from(i).unwrap_or(0)));
        }
        out.push(f);
    }
    let by_object = index(&|c| machine(c.kind));
    if meta.by_layer && !by_object.is_empty() {
        let (extra, moves) = by_layer_cost(meta);
        let mut f = fix(FixKind::ByLayer, extra, by_object, true);
        f.moves = u32::try_from(moves).unwrap_or(u32::MAX);
        out.push(f);
    }
    let sideways = index(&|c| c.kind == Kind::Hotend && c.part == Part::Toolhead);
    if !sideways.is_empty() {
        let mut need = 0.0f32;
        for &i in &sideways {
            if let Some(c) = collisions.get(i as usize) {
                need = need.max(if c.severity == Severity::Close {
                    c.push_mm
                } else {
                    c.push_mm.max(1.0)
                });
            }
        }
        let mm = (need + 1.0).ceil();
        let mut f = fix(FixKind::Spread, 0.0, sideways, false);
        f.mm = Some(mm);
        out.push(f);
    }
    let travels = index(&|c| c.kind == Kind::NozzleTravelThroughPart);
    if !travels.is_empty() {
        let mut depth = 0.0f32;
        let mut moves = 0u32;
        for h in kept.iter().filter(|h| h.kind == Kind::NozzleTravelThroughPart) {
            depth = depth.max(h.depth);
            moves += h.moves;
        }
        let hop = f64::from(meta.z_hop).max(0.0);
        let lift = ((f64::from(depth) + 0.4) * 10.0).ceil() / 10.0 + hop;
        let extra = f64::from(moves) * 2.0 * (lift - hop) / f64::from(meta.z_speed).max(1.0);
        let mut f = fix(FixKind::RaiseLift, extra, travels, false);
        #[allow(clippy::cast_possible_truncation, reason = "mm")]
        {
            f.mm = Some(lift as f32);
        }
        out.push(f);
    }
    let mut lanes: Vec<&str> = Vec::new();
    for c in collisions {
        if !matches!(c.kind, Kind::ToolChange | Kind::Dock) || lanes.contains(&c.hit_id.as_str()) {
            continue;
        }
        lanes.push(&c.hit_id);
        let clears = index(&|x| matches!(x.kind, Kind::ToolChange | Kind::Dock) && x.hit_id == c.hit_id);
        let mut f = fix(FixKind::MoveObject, 0.0, clears, false);
        f.object_id = Some(c.hit_id.clone());
        out.push(f);
    }
    let crossings = index(&|c| c.kind == Kind::PathConflict);
    if !crossings.is_empty() {
        out.push(fix(FixKind::Arrange, 0.0, crossings, true));
    }
    let mut kept_out: Vec<&str> = Vec::new();
    for c in collisions {
        if c.kind != Kind::KeepOut || kept_out.contains(&c.object_id.as_str()) {
            continue;
        }
        kept_out.push(&c.object_id);
        let clears = index(&|x| x.kind == Kind::KeepOut && x.object_id == c.object_id);
        let mut f = fix(FixKind::MoveObject, 0.0, clears, false);
        f.object_id = Some(c.object_id.clone());
        out.push(f);
    }
    out
}

/// What printing by layer adds: on every layer the nozzle moves from object to object, lifting and retracting each
/// time. Objects drop out as the layers pass their tops. Returns the seconds and the most moves on one layer.
fn by_layer_cost(meta: &Meta) -> (f64, usize) {
    let hop = f64::from(meta.retract_s) + 2.0 * f64::from(meta.z_hop) / f64::from(meta.z_speed).max(1.0);
    let mut total = 0.0;
    let mut most = 0;
    let mut below = 0.0f32;
    // Each band between one object's top and the next: the objects still printing, nearest one next.
    while let Some(top) = meta
        .objects
        .iter()
        .map(|o| o.height)
        .filter(|&h| h > below)
        .reduce(f32::min)
    {
        let mut left: Vec<[f32; 2]> = Vec::new();
        for o in &meta.objects {
            if o.height >= top {
                left.push(o.center);
            }
        }
        let moves = left.len().saturating_sub(1);
        if moves == 0 {
            break;
        }
        let mut at = left.swap_remove(0);
        let mut tour = 0.0;
        while !left.is_empty() {
            let mut near = (f64::INFINITY, 0);
            for (k, c) in left.iter().enumerate() {
                let d = f64::from(((c[0] - at[0]) * (c[0] - at[0]) + (c[1] - at[1]) * (c[1] - at[1])).sqrt());
                if d < near.0 {
                    near = (d, k);
                }
            }
            tour += near.0;
            at = left.swap_remove(near.1);
        }
        let layers = f64::from(top - below) / f64::from(meta.layer_height).max(0.01);
        #[allow(clippy::cast_precision_loss, reason = "a handful of objects")]
        {
            total += layers * (tour / f64::from(meta.travel_speed).max(1.0) + moves as f64 * hop);
        }
        most = most.max(moves);
        below = top;
    }
    (total, most)
}

#[cfg(test)]
mod tests {
    use super::super::{Hit, Kind, Meta, MetaObject, Moment, Part, Severity};
    use super::*;

    fn obj(id: &str, h: f32, x: f32) -> MetaObject {
        MetaObject {
            id: id.to_owned(),
            height: h,
            center: [x, 100.0],
        }
    }

    fn hit(kind: Kind, part: Part, mover: u32, obstacle: u32, layer: u32) -> Hit {
        let m = Moment {
            layer,
            segment: 3,
            share: 0.5,
            at: [0.0; 3],
            point: [0.0; 3],
            change: None,
        };
        Hit {
            kind,
            severity: Severity::Hit,
            part,
            mover,
            obstacle,
            first: m,
            worst: m,
            depth: 8.0,
            push: 4.0,
            last_layer: layer + 10,
            moves: 20,
            near: f32::MAX,
        }
    }

    fn meta(objects: Vec<MetaObject>) -> Meta {
        Meta {
            objects,
            radius: 40.0,
            rod: 40.0,
            lid: 120.0,
            layer_height: 0.2,
            travel_speed: 300.0,
            z_speed: 12.0,
            retract_s: 0.1,
            z_hop: 0.4,
            by_layer: true,
            zones: Vec::new(),
        }
    }

    #[test]
    fn only_objects_printed_before_count_and_the_tall_one_goes_last() {
        let m = meta(vec![
            obj("tall", 48.0, 50.0),
            obj("b", 10.0, 120.0),
            obj("c", 10.0, 190.0),
        ]);
        // c's gantry passes over tall (printed first); tall's moves would meet b and c only if they came first.
        let hits = vec![
            hit(Kind::Gantry, Part::Gantry, 2, 0, 400),
            hit(Kind::Gantry, Part::Gantry, 1, 0, 200),
        ];
        let r = report(&m, &hits, &[1.0; 600], 30.0);
        assert_eq!(r.collisions.len(), 2);
        // b prints before c, so its strike comes first, at 30 s + 200 layers + half a layer
        assert_eq!(r.collisions[0].object_id, "b");
        assert!((r.collisions[0].time_s - 230.5).abs() < 1e-9);
        assert!(
            (r.collisions[0].limit_mm - 40.0).abs() < 1e-6
                && (r.collisions[0].hit_height_mm - 48.0).abs() < 1e-6
        );
        let reorder = r.fixes.iter().find(|f| f.kind == FixKind::Reorder).unwrap();
        assert_eq!(reorder.order, ["b", "c", "tall"]);
        assert_eq!(reorder.clears, [0, 1]);
        assert!(reorder.one_click);
        let by_layer = r.fixes.iter().find(|f| f.kind == FixKind::ByLayer).unwrap();
        assert!(by_layer.cost_s > 0.0 && by_layer.clears.len() == 2);
    }

    #[test]
    fn a_reorder_says_which_close_calls_it_leaves() {
        let m = meta(vec![obj("tall", 48.0, 50.0), obj("low", 10.0, 120.0)]);
        // low's gantry passes over tall; in the other order tall's head passes inside the radius of low
        let mut close = hit(Kind::Hotend, Part::Toolhead, 0, 1, 50);
        close.severity = Severity::Close;
        let hits = vec![hit(Kind::Gantry, Part::Gantry, 1, 0, 200), close];
        let r = report(&m, &hits, &[], 0.0);
        let reorder = r.fixes.iter().find(|f| f.kind == FixKind::Reorder).unwrap();
        assert_eq!(reorder.order, ["low", "tall"]);
        assert_eq!(reorder.close_calls, 1);
    }

    #[test]
    fn a_cycle_gets_no_order_that_trades_one_strike_for_another() {
        let m = meta(vec![obj("a", 30.0, 50.0), obj("b", 30.0, 80.0)]);
        // a meets b and b meets a, whichever goes first
        let hits = vec![
            hit(Kind::Hotend, Part::Toolhead, 1, 0, 5),
            hit(Kind::Hotend, Part::Toolhead, 0, 1, 5),
        ];
        let r = report(&m, &hits, &[], 0.0);
        assert_eq!(r.collisions.len(), 1);
        assert!(!r.fixes.iter().any(|f| f.kind == FixKind::Reorder));
        let spread = r.fixes.iter().find(|f| f.kind == FixKind::Spread).unwrap();
        assert_eq!(spread.mm, Some(5.0));
        assert!(!spread.one_click);
    }

    #[test]
    fn a_close_call_shows_only_where_the_head_itself_clears() {
        let m = meta(vec![obj("a", 30.0, 50.0), obj("b", 30.0, 80.0)]);
        let mut close = hit(Kind::Hotend, Part::Toolhead, 1, 0, 0);
        close.severity = Severity::Close;
        let r = report(&m, &[close.clone()], &[], 0.0);
        assert_eq!(r.collisions.len(), 1);
        assert_eq!(r.collisions[0].severity, Severity::Close);
        let r = report(&m, &[close, hit(Kind::Hotend, Part::Toolhead, 1, 0, 0)], &[], 0.0);
        assert_eq!(r.collisions.len(), 1);
        assert_eq!(r.collisions[0].severity, Severity::Hit);
    }

    #[test]
    fn printing_by_layer_costs_a_hop_between_objects_on_every_shared_layer() {
        let m = meta(vec![obj("a", 10.0, 0.0), obj("b", 10.0, 300.0)]);
        let (s, moves) = by_layer_cost(&m);
        // 50 layers, each 300 mm at 300 mm/s plus a retraction and two 0.4 mm lifts at 12 mm/s
        assert_eq!(moves, 1);
        assert!((s - 50.0 * (1.0 + 0.1 + 0.8 / 12.0)).abs() < 1e-3, "{s}");
    }
}
