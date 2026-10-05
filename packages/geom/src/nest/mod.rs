// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! true shape nesting for arrange and fill the bed: real outlines with their holes and
//! concavities, grown by what prints round them, placed on no fit polygons at any turn

pub mod place;
pub mod poly;
pub mod silhouette;

pub use place::{
    LeftOver, NestBed, NestFixed, NestItem, NestOptions, NestProblem, NestResult, NestStats, NestZone,
    Nester, Placement, TooLarge, nest,
};
pub use silhouette::{Mat4, Silhouette, SilhouetteOptions, silhouette};

use crate::error::{Error, Result};
use std::cell::RefCell;
use std::collections::BTreeMap;

/// a run the browser drives one pass at a time so it can show progress and stop
struct Sessions {
    next: u32,
    open: BTreeMap<u32, Nester>,
}

thread_local! {
    static SESSIONS: RefCell<Sessions> = const { RefCell::new(Sessions { next: 1, open: BTreeMap::new() }) };
}

/// how a session stands after some passes
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub session: u32,
    pub done: usize,
    pub passes: usize,
    pub finished: bool,
    pub result: NestResult,
}

fn progress(id: u32, n: &mut Nester) -> Progress {
    Progress {
        session: id,
        done: n.done(),
        passes: n.passes(),
        finished: n.finished(),
        result: n.result(),
    }
}

/// opens a session and runs its first pass
pub fn start(p: NestProblem) -> Result<Progress> {
    let mut n = Nester::new(p)?;
    n.step();
    SESSIONS.with(|s| {
        let mut s = s.borrow_mut();
        // a few runs at most: an abandoned one goes first
        while s.open.len() >= 4 {
            let Some(&old) = s.open.keys().next() else { break };
            s.open.remove(&old);
        }
        let id = s.next;
        s.next = s.next.wrapping_add(1).max(1);
        let out = progress(id, &mut n);
        s.open.insert(id, n);
        Ok(out)
    })
}

/// runs up to `passes` more passes
pub fn step(id: u32, passes: usize) -> Result<Progress> {
    SESSIONS.with(|s| {
        let mut s = s.borrow_mut();
        let n = s
            .open
            .get_mut(&id)
            .ok_or_else(|| Error::invalid("session", "no such nesting run (it ended or was replaced)"))?;
        for _ in 0..passes.max(1) {
            if !n.step() {
                break;
            }
        }
        Ok(progress(id, n))
    })
}

pub fn end(id: u32) {
    SESSIONS.with(|s| {
        s.borrow_mut().open.remove(&id);
    });
}

#[cfg(test)]
mod tests {
    use super::poly::{self, Region, Ring};
    use super::*;
    use crate::fm::Fm as _;
    use crate::poly2d::Polygon;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Polygon {
        Polygon::simple(vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
    }

    fn ell(x: f64, y: f64, s: f64, t: f64) -> Polygon {
        Polygon::simple(vec![
            [x, y],
            [x + s, y],
            [x + s, y + t],
            [x + t, y + t],
            [x + t, y + s],
            [x, y + s],
        ])
    }

    fn ring(cx: f64, cy: f64, ro: f64, ri: f64) -> Polygon {
        let mut hole = crate::poly2d::circle([cx, cy], ri, 64);
        hole.reverse();
        Polygon {
            outer: crate::poly2d::circle([cx, cy], ro, 64),
            holes: vec![hole],
        }
    }

    fn item(id: &str, polys: Vec<Polygon>) -> NestItem {
        NestItem {
            id: id.into(),
            polygons: polys,
            grow: 0.0,
            reach: 0.0,
            copies: 1,
            hull: vec![],
        }
    }

    fn bed(w: f64, d: f64) -> NestBed {
        NestBed {
            width_mm: w,
            depth_mm: d,
        }
    }

    fn opts(gap: f64) -> NestOptions {
        NestOptions {
            gap_mm: gap,
            ..NestOptions::default()
        }
    }

    /// the outline of an item where the result put it
    fn placed(items: &[NestItem], p: &Placement) -> Region {
        let it = items.iter().find(|i| i.id == p.id).unwrap();
        let rings: Vec<Ring> = it
            .polygons
            .iter()
            .flat_map(|q| std::iter::once(q.outer.clone()).chain(q.holes.clone()))
            .collect();
        let r = poly::union_rings(&rings);
        poly::translate(&poly::rotate(&r, poly::turn(p.angle_deg)), p.offset)
    }

    /// the smallest distance between two outlines, by sampling their edges against each other
    fn distance(a: &Region, b: &Region) -> f64 {
        if !poly::intersection(a, b).is_empty() {
            return 0.0;
        }
        let seg = |p: [f64; 2], u: [f64; 2], v: [f64; 2]| {
            let (dx, dy) = (v[0] - u[0], v[1] - u[1]);
            let l = dx * dx + dy * dy;
            let t = if l > 0.0 {
                (((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / l).clamp(0.0, 1.0)
            } else {
                0.0
            };
            ((u[0] + t * dx - p[0]).m_powi(2) + (u[1] + t * dy - p[1]).m_powi(2)).sqrt()
        };
        let mut best = f64::INFINITY;
        for (x, y) in [(a, b), (b, a)] {
            for p in x.iter().flatten().flatten() {
                for r in y.iter().flatten() {
                    for i in 0..r.len() {
                        best = best.min(seg(*p, r[i], r[(i + 1) % r.len()]));
                    }
                }
            }
        }
        best
    }

    fn check_spacing(items: &[NestItem], out: &NestResult, gap: f64, bedw: f64, bedd: f64) {
        let regions: Vec<Region> = out.placements.iter().map(|p| placed(items, p)).collect();
        for (i, a) in regions.iter().enumerate() {
            let b = poly::bbox(a);
            assert!(b.min[0] >= gap - 1e-3 && b.min[1] >= gap - 1e-3, "{b:?}");
            assert!(
                b.max[0] <= bedw - gap + 1e-3 && b.max[1] <= bedd - gap + 1e-3,
                "{b:?}"
            );
            for c in regions.iter().skip(i + 1) {
                let d = distance(a, c);
                assert!(d >= gap - 0.01, "parts {d} mm apart, want {gap}");
            }
        }
    }

    #[test]
    fn rectangles_fit_and_keep_their_gap() {
        let items: Vec<NestItem> = (0..6)
            .map(|i| item(&format!("r{i}"), vec![rect(0.0, 0.0, 50.0, 30.0)]))
            .collect();
        let out = nest(NestProblem {
            bed: bed(200.0, 200.0),
            items: items.clone(),
            fixed: vec![],
            zones: vec![],
            options: opts(5.0),
        })
        .unwrap();
        assert_eq!(out.placements.len(), 6);
        check_spacing(&items, &out, 5.0, 200.0, 200.0);
    }

    #[test]
    fn parts_printed_by_object_keep_the_clearance_apart_but_not_from_the_edge() {
        let items: Vec<NestItem> = (0..2)
            .map(|i| item(&format!("b{i}"), vec![rect(0.0, 0.0, 20.0, 20.0)]))
            .collect();
        let out = nest(NestProblem {
            bed: bed(256.0, 256.0),
            items: items.clone(),
            fixed: vec![],
            zones: vec![],
            options: NestOptions {
                apart_mm: 68.0,
                center: false,
                ..opts(6.0)
            },
        })
        .unwrap();
        assert_eq!(out.placements.len(), 2);
        assert!(out.left_over.is_empty());
        let regions: Vec<Region> = out.placements.iter().map(|p| placed(&items, p)).collect();
        let d = distance(&regions[0], &regions[1]);
        assert!(d >= 68.0 - 0.01, "parts {d} mm apart, want 68");
        // the bed edge keeps the plain gap, so the first part sits in the corner
        let near = regions
            .iter()
            .map(|r| poly::bbox(r).min[0].min(poly::bbox(r).min[1]))
            .fold(f64::INFINITY, f64::min);
        assert!(near < 20.0, "nearest edge {near} mm, want the 6 mm gap");
    }

    #[test]
    fn a_plate_too_full_for_the_clearance_finishes_with_the_rest_left_over() {
        let items: Vec<NestItem> = (0..9)
            .map(|i| item(&format!("b{i}"), vec![rect(0.0, 0.0, 40.0, 40.0)]))
            .collect();
        let out = nest(NestProblem {
            bed: bed(200.0, 200.0),
            items: items.clone(),
            fixed: vec![],
            zones: vec![],
            options: NestOptions {
                apart_mm: 68.0,
                ..opts(6.0)
            },
        })
        .unwrap();
        assert!(!out.placements.is_empty());
        assert_eq!(out.placements.len() + out.left_over.len(), 9);
        assert!(!out.left_over.is_empty());
        let regions: Vec<Region> = out.placements.iter().map(|p| placed(&items, p)).collect();
        for (i, a) in regions.iter().enumerate() {
            for b in regions.iter().skip(i + 1) {
                let d = distance(a, b);
                assert!(d >= 68.0 - 0.01, "parts {d} mm apart, want 68");
            }
        }
    }

    #[test]
    fn l_brackets_tuck_into_each_other() {
        // two 60 mm Ls with 12 mm legs need a 72 x 72 box side by side as boxes; nested they fit
        // a bed only 86 mm across (each L's bounds are 60 x 60, the pair nests in about 74 x 74)
        let items: Vec<NestItem> = (0..2)
            .map(|i| item(&format!("l{i}"), vec![ell(0.0, 0.0, 60.0, 12.0)]))
            .collect();
        let out = nest(NestProblem {
            bed: bed(86.0, 86.0),
            items: items.clone(),
            fixed: vec![],
            zones: vec![],
            options: opts(2.0),
        })
        .unwrap();
        assert_eq!(out.placements.len(), 2, "{:?}", out.left_over);
        check_spacing(&items, &out, 2.0, 86.0, 86.0);
    }

    #[test]
    fn a_small_part_goes_inside_a_ring() {
        // a 100 mm ring on a 110 mm bed leaves no room outside; the washer must go in the hole
        let items = vec![
            item("ring", vec![ring(0.0, 0.0, 50.0, 35.0)]),
            item("washer", vec![ring(0.0, 0.0, 12.0, 4.0)]),
        ];
        let out = nest(NestProblem {
            bed: bed(110.0, 110.0),
            items: items.clone(),
            fixed: vec![],
            zones: vec![],
            options: opts(3.0),
        })
        .unwrap();
        assert_eq!(out.placements.len(), 2, "{:?}", out.left_over);
        check_spacing(&items, &out, 3.0, 110.0, 110.0);
    }

    #[test]
    fn brims_count_between_parts() {
        let mut items: Vec<NestItem> = (0..4)
            .map(|i| item(&format!("b{i}"), vec![rect(0.0, 0.0, 30.0, 30.0)]))
            .collect();
        for it in &mut items {
            it.grow = 6.0;
            it.reach = 6.0;
        }
        let out = nest(NestProblem {
            bed: bed(150.0, 150.0),
            items: items.clone(),
            fixed: vec![],
            zones: vec![],
            options: opts(3.0),
        })
        .unwrap();
        assert_eq!(out.placements.len(), 4);
        // two 6 mm brims and the 1 mm safety between parts, 7 mm from the edge
        check_spacing(&items, &out, 7.0, 150.0, 150.0);
        let regions: Vec<Region> = out.placements.iter().map(|p| placed(&items, p)).collect();
        for (i, a) in regions.iter().enumerate() {
            for c in regions.iter().skip(i + 1) {
                assert!(distance(a, c) >= 13.0 - 0.01);
            }
        }
    }

    #[test]
    fn fixed_parts_zones_and_the_tower_stay_clear() {
        let items: Vec<NestItem> = (0..8)
            .map(|i| item(&format!("p{i}"), vec![rect(0.0, 0.0, 30.0, 20.0)]))
            .collect();
        let fixed = vec![NestFixed {
            id: "f".into(),
            polygons: vec![rect(80.0, 80.0, 40.0, 40.0)],
            grow: 0.0,
            reach: 0.0,
            hull: vec![],
        }];
        let zones = vec![
            NestZone {
                polygons: vec![rect(0.0, 0.0, 40.0, 40.0)],
            },
            NestZone {
                polygons: vec![rect(150.0, 150.0, 50.0, 50.0)],
            },
        ];
        let out = nest(NestProblem {
            bed: bed(200.0, 200.0),
            items: items.clone(),
            fixed: fixed.clone(),
            zones: zones.clone(),
            options: opts(4.0),
        })
        .unwrap();
        assert_eq!(out.placements.len(), 8);
        check_spacing(&items, &out, 4.0, 200.0, 200.0);
        let f: Region = vec![vec![fixed[0].polygons[0].outer.clone()]];
        for p in &out.placements {
            let r = placed(&items, p);
            assert!(distance(&r, &f) >= 4.0 - 0.01);
            for z in &zones {
                let zr: Region = vec![vec![z.polygons[0].outer.clone()]];
                assert!(distance(&r, &zr) >= 4.0 - 0.01);
            }
        }
    }

    #[test]
    fn the_same_problem_gives_the_same_layout() {
        let mk = || {
            let mut items = vec![];
            for i in 0..5 {
                items.push(item(
                    &format!("l{i}"),
                    vec![ell(0.0, 0.0, 40.0 + f64::from(i) * 3.0, 10.0)],
                ));
                items.push(item(&format!("r{i}"), vec![ring(0.0, 0.0, 15.0, 8.0)]));
            }
            NestProblem {
                bed: bed(180.0, 180.0),
                items,
                fixed: vec![],
                zones: vec![],
                options: opts(3.0),
            }
        };
        let a = nest(mk()).unwrap();
        let b = nest(mk()).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.placements.len(), 10);
    }

    #[test]
    fn fill_places_copies_until_the_bed_is_full_and_beats_boxes() {
        // 30 x 30 Ls with 8 mm legs: as boxes with a 2 mm gap a 200 mm bed takes 6 x 6 = 36
        let mut it = item("l", vec![ell(0.0, 0.0, 30.0, 8.0)]);
        it.copies = 200;
        let out = nest(NestProblem {
            bed: bed(200.0, 200.0),
            items: vec![it.clone()],
            fixed: vec![],
            zones: vec![],
            options: opts(2.0),
        })
        .unwrap();
        let n = out.placements.len();
        assert!(n > 36, "{n}");
        assert_eq!(out.left_over[0].copies as usize, 200 - n);
        check_spacing(&[it], &out, 2.0, 200.0, 200.0);
    }

    #[test]
    fn too_large_parts_are_named() {
        let mut big = item("big", vec![rect(0.0, 0.0, 95.0, 95.0)]);
        big.reach = 8.0;
        let out = nest(NestProblem {
            bed: bed(100.0, 100.0),
            items: vec![big, item("huge", vec![rect(0.0, 0.0, 150.0, 20.0)])],
            fixed: vec![],
            zones: vec![],
            options: opts(2.0),
        })
        .unwrap();
        assert!(out.placements.is_empty());
        assert_eq!(out.too_large.len(), 2);
        assert!(out.too_large[0].without_margin);
        assert!(!out.too_large[1].without_margin);
    }

    #[test]
    fn turns_other_than_quarter_turns_are_used() {
        // a long bar only fits a square bed on the diagonal
        let out = nest(NestProblem {
            bed: bed(100.0, 100.0),
            items: vec![item("bar", vec![rect(0.0, 0.0, 120.0, 8.0)])],
            fixed: vec![],
            zones: vec![],
            options: opts(1.0),
        })
        .unwrap();
        assert_eq!(out.placements.len(), 1);
        let a = out.placements[0].angle_deg.rem_euclid(90.0);
        assert!(a > 1.0 && a < 89.0, "{a}");
    }

    #[test]
    fn sessions_step_to_the_same_result() {
        let mk = || {
            let items: Vec<NestItem> = (0..6)
                .map(|i| item(&format!("l{i}"), vec![ell(0.0, 0.0, 30.0 + f64::from(i), 9.0)]))
                .collect();
            NestProblem {
                bed: bed(120.0, 120.0),
                items,
                fixed: vec![],
                zones: vec![],
                options: opts(2.0),
            }
        };
        let all = nest(mk()).unwrap();
        let mut p = start(mk()).unwrap();
        while !p.finished {
            p = step(p.session, 3).unwrap();
        }
        end(p.session);
        assert_eq!(p.result, all);
        assert!(step(p.session, 1).is_err());
    }
}
