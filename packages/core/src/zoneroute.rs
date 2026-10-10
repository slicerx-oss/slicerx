// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Travels around the printer's keep-out zones (`bed_exclude_area`, the A1 family's `head_wrap_detect_zone`).
//!
//! A travel that runs into a zone, or passes within the nozzle's width of one closer than its own ends
//! ([`crate::preflight::travel_meets`]), is routed round it, in this order:
//!
//! 1. the short way round the zone, grown by the nozzle's width;
//! 2. the long way round;
//! 3. straight, lifted by the profile's travel lift (`z_hop`) while it crosses, when the profile has one and
//!    the lift stays under the printable height;
//! 4. none: the travel stays straight, and the collision check reports it as before.
//!
//! A way round counts only when every leg of it stays on the bed and clear of every zone. The G-code writer and
//! the collision check ask the same router, so a travel the writer routes is never reported, and one it cannot
//! route always is.

use crate::fm::Fm as _;
use crate::perimeters::Shapes;
use crate::preflight::{EDGE_TOL_MM, travel_meets};

type Pt = [f64; 2];

/// How far past the nozzle's width the way round keeps, mm.
const MARGIN_MM: f64 = 0.02;

/// What a travel does about the zones.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Route {
    /// It meets no zone: straight, as planned.
    Clear,
    /// Round a zone: the points after the start, the travel's own end last.
    Around(Vec<Pt>),
    /// Straight, lifted by this much (mm) while it travels.
    Lift(f64),
    /// No way round and no lift: straight, and reported.
    Blocked,
}

/// The zones, the bed and the lift of one set of settings.
pub(crate) struct Router {
    zones: Vec<Vec<Pt>>,
    bed: Vec<Pt>,
    clearance: f64,
    lift: f64,
    printable_height: f64,
}

fn dist(a: Pt, b: Pt) -> f64 {
    (a[0] - b[0]).m_hypot(a[1] - b[1])
}

fn dist_to_segment(p: Pt, a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    dist(p, [a[0] + t * dx, a[1] + t * dy])
}

/// Distance from `p` to the edge of `poly`.
fn edge_dist(poly: &[Pt], p: Pt) -> f64 {
    let n = poly.len();
    (0..n)
        .filter_map(|i| Some(dist_to_segment(p, *poly.get(i)?, *poly.get((i + 1) % n)?)))
        .fold(f64::INFINITY, f64::min)
}

/// The least distance from the segment `a`-`b` to the edge of `poly`, for a segment that does not cross it: at a
/// corner of the polygon or at an end of the segment.
fn seg_zone_dist(poly: &[Pt], a: Pt, b: Pt) -> f64 {
    poly.iter()
        .map(|&c| dist_to_segment(c, a, b))
        .chain([edge_dist(poly, a), edge_dist(poly, b)])
        .fold(f64::INFINITY, f64::min)
}

fn inside(poly: &[Pt], p: Pt) -> bool {
    let n = poly.len();
    let mut c = false;
    for i in 0..n {
        let (Some(a), Some(b)) = (poly.get(i), poly.get((i + 1) % n)) else {
            continue;
        };
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            c = !c;
        }
    }
    c
}

/// `zone` grown by `by` mm, as one ring (the outer contour of the grown shape).
fn grown(zone: &[Pt], by: f64) -> Option<Vec<Pt>> {
    use crate::geom::{SCALE, mm};
    use i_overlay::i_float::int::point::IntPoint;
    let ring: Vec<IntPoint<i32>> = zone.iter().map(|p| IntPoint::new(mm(p[0]), mm(p[1]))).collect();
    let shape: Shapes = vec![vec![ring]];
    let norm = crate::perimeters::union_all(&[&shape]);
    let out = crate::perimeters::offset(&norm, mm(by).max(1));
    let outer = out.first()?.first()?;
    (outer.len() >= 3).then(|| {
        outer
            .iter()
            .map(|p| [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE])
            .collect()
    })
}

/// Where the segment `a`-`b` crosses `ring`: (position along the segment 0 to 1, edge index, point).
fn crossings(ring: &[Pt], a: Pt, b: Pt) -> Vec<(f64, usize, Pt)> {
    let n = ring.len();
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let mut out = Vec::new();
    for i in 0..n {
        let (Some(c), Some(d)) = (ring.get(i), ring.get((i + 1) % n)) else {
            continue;
        };
        let (ex, ey) = (d[0] - c[0], d[1] - c[1]);
        let den = dx * ey - dy * ex;
        if den.abs() < 1e-12 {
            continue;
        }
        let t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
        let u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
        if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
            out.push((t, i, [a[0] + t * dx, a[1] + t * dy]));
        }
    }
    crate::sorting::sort_by(&mut out, |x, y| x.0.total_cmp(&y.0));
    out
}

fn length(a: Pt, pts: &[Pt]) -> f64 {
    let mut from = a;
    pts.iter()
        .map(|&p| {
            let d = dist(from, p);
            from = p;
            d
        })
        .sum()
}

impl Router {
    /// The router of `cfg`'s zones, or None when it has none.
    pub(crate) fn of(cfg: &crate::config::PrintConfig) -> Option<Self> {
        let zones: Vec<Vec<Pt>> = crate::collide::plate::zones(cfg)
            .into_iter()
            .map(|(_, z)| z)
            .collect();
        if zones.is_empty() {
            return None;
        }
        Some(Self {
            zones,
            bed: cfg.printable_area.clone(),
            clearance: cfg.nozzle_diameter.max(0.0),
            lift: cfg.z_hop.max(0.0),
            printable_height: cfg.printable_height,
        })
    }

    /// Whether the leg `a`-`b` stays on the bed and clear of every zone: out of each, and no closer to `around` than
    /// `floor` (mm), nor to the others than [`travel_meets`] allows.
    fn leg_clear(&self, a: Pt, b: Pt, around: &[Pt], floor: f64) -> bool {
        let on_bed = self.bed.len() < 3
            || ((inside(&self.bed, a) || edge_dist(&self.bed, a) <= EDGE_TOL_MM)
                && (inside(&self.bed, b) || edge_dist(&self.bed, b) <= EDGE_TOL_MM)
                && crate::preflight::segment_reaches(&self.bed, a, b, false, EDGE_TOL_MM).is_none());
        on_bed
            && self.zones.iter().all(|z| {
                if z.as_slice() == around {
                    crate::preflight::segment_reaches(z, a, b, true, EDGE_TOL_MM).is_none()
                        && seg_zone_dist(z, a, b) + EDGE_TOL_MM >= floor
                } else {
                    travel_meets(z, a, b, self.clearance, EDGE_TOL_MM).is_none()
                }
            })
    }

    /// The route of a travel from `a` to `b` at height `z` (mm).
    pub(crate) fn route(&self, a: Pt, b: Pt, z: f64) -> Route {
        let Some(zone) = self
            .zones
            .iter()
            .find(|zone| travel_meets(zone, a, b, self.clearance, EDGE_TOL_MM).is_some())
        else {
            return Route::Clear;
        };
        let floor = self.floor(zone, a, b);
        let mut ways = self.ways_round(zone, a, b);
        crate::sorting::sort_by(&mut ways, |x, y| length(a, x).total_cmp(&length(a, y)));
        for way in ways {
            let mut from = a;
            let ok = way.iter().all(|&p| {
                let c = self.leg_clear(from, p, zone, floor);
                from = p;
                c
            });
            if ok {
                return Route::Around(way);
            }
        }
        if self.lift > 0.0 && z + self.lift <= self.printable_height + 1e-6 {
            return Route::Lift(self.lift);
        }
        Route::Blocked
    }

    /// How close a way round `zone` may pass: the nozzle's width, or as close as the travel's own ends already are
    /// (a travel that leaves a path printed beside the zone).
    fn floor(&self, zone: &[Pt], a: Pt, b: Pt) -> f64 {
        self.clearance.min(edge_dist(zone, a)).min(edge_dist(zone, b))
    }

    /// The two ways round `zone`, grown to just past [`Self::floor`], each straightened: the points after `a`, ending
    /// at `b`.
    fn ways_round(&self, zone: &[Pt], a: Pt, b: Pt) -> Vec<Vec<Pt>> {
        // The ring passes just inside a travel's ends that sit closer than the nozzle's width, so it is crossed.
        let floor = self.floor(zone, a, b);
        let by = if floor < self.clearance {
            (floor - EDGE_TOL_MM / 2.0).max(0.001)
        } else {
            self.clearance + MARGIN_MM
        };
        let Some(ring) = grown(zone, by) else {
            return Vec::new();
        };
        let hits = crossings(&ring, a, b);
        let (Some(&(_, e_in, p_in)), Some(&(_, e_out, p_out))) = (hits.first(), hits.last()) else {
            return Vec::new();
        };
        if hits.len() < 2 || inside(&ring, a) || inside(&ring, b) {
            return Vec::new();
        }
        let n = ring.len();
        // Forward: from the entry edge's end vertex on to the exit edge's start vertex; backward the other way.
        let mut forward = vec![p_in];
        let mut i = (e_in + 1) % n;
        for _ in 0..n {
            if let Some(&v) = ring.get(i) {
                forward.push(v);
            }
            if i == e_out {
                break;
            }
            i = (i + 1) % n;
        }
        forward.push(p_out);
        forward.push(b);
        let mut backward = vec![p_in];
        let mut i = e_in;
        for _ in 0..n {
            if let Some(&v) = ring.get(i) {
                backward.push(v);
            }
            if i == (e_out + 1) % n {
                break;
            }
            i = (i + n - 1) % n;
        }
        backward.push(p_out);
        backward.push(b);
        vec![
            self.straighten(a, &forward, zone, floor),
            self.straighten(a, &backward, zone, floor),
        ]
    }

    /// Drops the points a straight leg can skip: from each point, on to the furthest later one it reaches clear.
    fn straighten(&self, a: Pt, pts: &[Pt], zone: &[Pt], floor: f64) -> Vec<Pt> {
        let mut out = Vec::new();
        let mut from = a;
        let mut k = 0;
        while k < pts.len() {
            let mut next = k;
            for j in (k..pts.len()).rev() {
                if let Some(&p) = pts.get(j)
                    && self.leg_clear(from, p, zone, floor)
                {
                    next = j;
                    break;
                }
            }
            let Some(&p) = pts.get(next) else { break };
            out.push(p);
            from = p;
            k = next + 1;
        }
        out
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn router(zones: Vec<Vec<Pt>>, lift: f64) -> Router {
        Router {
            zones,
            bed: vec![[0.0, 0.0], [256.0, 0.0], [256.0, 256.0], [0.0, 256.0]],
            clearance: 0.4,
            lift,
            printable_height: 250.0,
        }
    }

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Pt> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    fn on_bed_and_clear(r: &Router, a: Pt, way: &[Pt]) {
        let (zone, b) = (&r.zones[0], *way.last().unwrap());
        let floor = r.floor(zone, a, b);
        let mut from = a;
        for &p in way {
            assert!(r.leg_clear(from, p, zone, floor), "{from:?} to {p:?} in {way:?}");
            assert!(
                (0.0..=256.0).contains(&p[0]) && (0.0..=256.0).contains(&p[1]),
                "{p:?}"
            );
            from = p;
        }
    }

    #[test]
    fn a_travel_clear_of_the_zone_is_left_alone() {
        let r = router(vec![rect(100.0, 100.0, 120.0, 110.0)], 0.4);
        assert_eq!(r.route([90.0, 50.0], [130.0, 50.0], 1.0), Route::Clear);
    }

    #[test]
    fn a_travel_through_a_zone_goes_the_short_way_round() {
        let r = router(vec![rect(100.0, 100.0, 120.0, 110.0)], 0.4);
        let (a, b) = ([90.0, 102.0], [130.0, 102.0]);
        let Route::Around(way) = r.route(a, b, 1.0) else {
            panic!()
        };
        on_bed_and_clear(&r, a, &way);
        assert!(dist(*way.last().unwrap(), b) < 1e-9);
        // Under the zone (2 mm down, 2 back up) rather than over it (8 and 8).
        assert!(
            way.iter().all(|p| p[1] < 100.0 || (p[1] - 102.0).abs() < 1e-9),
            "{way:?}"
        );
        let extra = length(a, &way) - dist(a, b);
        assert!(extra > 0.0 && extra < 6.0, "{extra}");
    }

    #[test]
    fn the_long_way_when_the_short_way_leaves_the_bed() {
        // A zone out from the left edge of the bed: round its left end is shorter, but off the bed.
        let r = router(vec![rect(0.0, 100.0, 30.0, 110.0)], 0.4);
        let (a, b) = ([10.0, 90.0], [12.0, 120.0]);
        let Route::Around(way) = r.route(a, b, 1.0) else {
            panic!()
        };
        on_bed_and_clear(&r, a, &way);
        assert!(way.iter().any(|p| p[0] > 30.0), "round the right end: {way:?}");
    }

    #[test]
    fn the_x1_corner_routes_on_the_bed() {
        let r = router(vec![rect(0.0, 0.0, 18.0, 28.0)], 0.4);
        for (a, b) in [
            ([12.0, 32.0], [30.0, 12.0]),
            ([18.6, 0.5], [0.5, 28.6]),
            ([25.0, 3.0], [3.0, 32.0]),
            ([11.012, 33.037], [39.37, 11.37]),
            ([2.7959, 34.0018], [39.37, 11.37]),
        ] {
            let Route::Around(way) = r.route(a, b, 1.0) else {
                panic!("{a:?} {b:?}")
            };
            on_bed_and_clear(&r, a, &way);
        }
    }

    #[test]
    fn a_zone_across_the_bed_is_lifted_over_or_reported() {
        // A band from edge to edge: both ways round leave the bed.
        let band = vec![rect(0.0, 100.0, 256.0, 110.0)];
        let (a, b) = ([50.0, 90.0], [50.0, 120.0]);
        assert_eq!(router(band.clone(), 0.4).route(a, b, 1.0), Route::Lift(0.4));
        // No travel lift in the profile, or none left under the printable height: reported.
        assert_eq!(router(band.clone(), 0.0).route(a, b, 1.0), Route::Blocked);
        assert_eq!(router(band, 0.4).route(a, b, 249.8), Route::Blocked);
    }

    #[test]
    fn a_travel_leaving_a_path_beside_the_zone_routes_as_close_as_it_starts() {
        // The travel starts 0.2 mm left of the zone, where a path printed beside it ended, and crosses it.
        let r = router(vec![rect(100.0, 100.0, 120.0, 110.0)], 0.4);
        let (a, b) = ([99.8, 105.0], [130.0, 105.0]);
        let Route::Around(way) = r.route(a, b, 1.0) else {
            panic!()
        };
        on_bed_and_clear(&r, a, &way);
    }
}
