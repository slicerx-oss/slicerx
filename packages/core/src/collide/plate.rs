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
    if let Some(serde_json::Value::Array(pts)) = config.raw.get("head_wrap_detect_zone") {
        // "80x95" from a preset, or [80, 95] once a host has read it into the schema's shape
        let poly: Vec<[f64; 2]> = pts.iter().filter_map(crate::preflight::point).collect();
        if poly.len() >= 3 {
            out.push((ZONE_WRAP_CHECK, poly));
        }
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

/// One drawn segment: its owner, whether it is support, its ends and its index in the layer.
#[derive(Clone, Copy)]
struct Seg {
    owner: u32,
    support: bool,
    a: [f64; 2],
    b: [f64; 2],
    index: u32,
}

/// The crossings and keep-out paths of `out`'s layers. Owners are the plate's objects (`out.objects`), then the prime
/// tower; zone `k` is obstacle `objects + 1 + k`. `crossings` is off for a plate printed by object, whose objects do not
/// share layers.
pub(crate) fn check(out: &SliceOutput, zones: &[(u8, Vec<[f64; 2]>)], crossings: bool) -> Hits {
    let mut hits = Hits::default();
    let n = u32::try_from(out.objects.len()).unwrap_or(u32::MAX);
    let finder = crate::preview::ObjectFinder::new(&out.objects);
    let mut boxes = Vec::with_capacity(zones.len());
    for (_, z) in zones {
        boxes.push(bounds(z, 0.0));
    }
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
        let near_zone = boxes
            .iter()
            .any(|b| b[0] <= lb[2] && lb[0] <= b[2] && b[1] <= lb[3] && lb[1] <= b[3]);
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
        let segs = segments(l, &finder, n);
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
        let mut add = |kind: Kind, mover: u32, obstacle: u32, m: Moment| {
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
                    );
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
                        add(Kind::PathConflict, mover, obstacle, at(s, p));
                    }
                }
                cell.push(i);
            }
        }
    }
    hits
}

/// A layer's extrusion segments with their owners; skirts and custom paths own nothing and are left out.
fn segments(l: &LayerPaths, finder: &crate::preview::ObjectFinder<'_>, tower: u32) -> Vec<Seg> {
    let mut out = Vec::new();
    let mut index = 0u32;
    for p in &l.paths {
        let pts = l.path_points(p);
        let owner = match p.feature {
            Feature::PrimeTower => Some(tower),
            Feature::Skirt | Feature::Custom => None,
            f => {
                let k = finder.object_of(f, pts);
                (k != crate::preview::OBJECT_NONE).then_some(u32::from(k))
            }
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
            start,
            end,
            tool: 1,
            feature,
            speed_mm_s: 50.0,
            width_mm: 0.42,
            flow: 1.0,
            dz: 0.0,
            overhang_fan: false,
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
                    path(0, 5, Feature::OuterWall),
                    path(5, 10, Feature::OuterWall),
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
        let hits = check(&out, &[], true);
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
                true
            )
            .is_empty()
        );
        assert!(check(&out, &[], false).is_empty());
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
        let hits = check(&out, &zone, false);
        assert_eq!(hits.0.len(), 1);
        // object a meets zone 0, named after the objects and the tower
        assert_eq!(
            (hits.0[0].kind, hits.0[0].mover, hits.0[0].obstacle),
            (Kind::KeepOut, 0, 3)
        );
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
        let hits = check(&out, &zone(148.0, 152.0), false);
        assert_eq!(hits.0.iter().map(|h| h.kind).collect::<Vec<_>>(), [Kind::KeepOut]);
        // Running along the zone's edge, within the contact tolerance, is not a hit.
        assert!(check(&out, &zone(149.97, 154.0), false).0.is_empty());
    }
}
