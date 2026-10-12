// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What needs holding up on each layer (spec section 2): the angle overhang, sharp tails (thin features
//! that start in the air), cantilevers, clusters with small-overhang removal, blockers, critical-only,
//! bridge removal, enforcers, and the organic additions.

use super::Input;
use super::ops::{self, P};
use super::params::Params;
use crate::fm::Fm as _;
use crate::perimeters::Shapes;

/// Tail size limit (mm): a part at most this wide in X or in Y can be a tail.
const TAIL_SIZE: f64 = 6.0;
/// Tail height limit (mm): taller tails stand on their own.
const TAIL_HEIGHT: f64 = 16.0;
/// Tail growth limit (mm).
const TAIL_GROWTH: f64 = 5.0;
/// Cantilever reach (mm).
const CANTILEVER: f64 = 3.0;
/// Resolution grow (mm).
const EPS_R: f64 = 0.0125;
/// Added to each side's bounding box size of a bottom-bridge surface before the size test against
/// `max_bridge_length` (both sides together, mm). The spec is silent on how far the reference's surfaces
/// reach past the gap; its output removes spans of 3 mm and less, keeps 4.5 mm and up, and goes either way
/// at 4 mm (kept 5 times of 6) with
/// the default 10 mm limit, while this slicer's surfaces reach about 1 mm past each side. Decided by
/// black-box comparison (design.md, "bridge size").
const BRIDGE_SIZE_MARGIN: f64 = 4.2;
/// Over this many overhang parts on a layer the detection guard (Q6) fires.
const GUARD_PARTS: usize = 100;

/// Detector settings beyond [`super::Settings`].
#[derive(Debug, Clone)]
#[allow(clippy::struct_excessive_bools, reason = "one field per boolean setting")]
pub(crate) struct Detect {
    /// Support only where enforcers ask (`support_type` tree(manual)).
    pub(crate) manual: bool,
    /// `enforce_support_layers`.
    pub(crate) enforce_layers: usize,
    /// `support_remove_small_overhang`.
    pub(crate) remove_small: bool,
    /// `support_critical_regions_only`.
    pub(crate) critical_only: bool,
    /// `max_bridge_length` (mm); 0 keeps bridges.
    pub(crate) max_bridge: f64,
    /// Width and spacing of the bridge flow of the walls (mm).
    pub(crate) bridge_width: f64,
    pub(crate) bridge_spacing: f64,
    /// Outer wall width, inner wall spacing (mm) and wall count, for approximate wall paths when the
    /// real ones are not given.
    pub(crate) outer_wall_width: f64,
    pub(crate) inner_wall_spacing: f64,
    pub(crate) wall_loops: u32,
    /// The height each object layer was sliced at.
    pub(crate) slice_z: Vec<f64>,
}

impl Default for Detect {
    fn default() -> Self {
        Self {
            manual: false,
            enforce_layers: 0,
            remove_small: true,
            critical_only: false,
            max_bridge: 10.0,
            bridge_width: 0.4,
            bridge_spacing: 0.4,
            outer_wall_width: 0.42,
            inner_wall_spacing: 0.4,
            wall_loops: 2,
            slice_z: Vec::new(),
        }
    }
}

/// Extrudable area (spec 2.2): the slices without the parts narrower than a line.
fn extrudable(slices: &Shapes, w: f64) -> Shapes {
    if slices.is_empty() {
        return Vec::new();
    }
    let opened = ops::grow(&ops::grow(slices, -w / 2.0), w);
    ops::inter(slices, &opened)
}

/// Bounding box size `(x, y)` in millimeters.
#[allow(clippy::cast_precision_loss, reason = "sizes on the plate")]
fn size(s: &Shapes) -> Option<(f64, f64)> {
    ops::bbox(s).map(|[x0, y0, x1, y1]| {
        (
            f64::from(x1 - x0) / crate::geom::SCALE,
            f64::from(y1 - y0) / crate::geom::SCALE,
        )
    })
}

/// A sharp tail on one layer and its accumulated height.
#[derive(Clone)]
struct Tail {
    area: Shapes,
    height: f64,
}

/// What the per-layer pass finds (spec 2.3 to 2.5).
#[derive(Default)]
struct Pass {
    parts: Vec<Shapes>,
    cantilevers: Shapes,
    tails: Vec<Tail>,
    /// Too many parts: the detection guard fired here.
    guarded: bool,
}

/// Largest distance from a vertex of `v`'s outline to the nearest edge of `b`.
fn reach(v: &Shapes, b: &Shapes) -> f64 {
    v.iter()
        .filter_map(|sh| sh.first())
        .flatten()
        .filter_map(|&q| ops::nearest_on_boundary(b, q).map(|(_, d)| d))
        .fold(0.0, f64::max)
}

#[allow(clippy::too_many_arguments, reason = "the inputs of one layer's pass")]
fn pass(
    p: &Params,
    d: &Detect,
    ext: &[Shapes],
    k: usize,
    h_prev: f64,
    auto: bool,
    w: f64,
    theta_tan: f64,
) -> Pass {
    let empty = Vec::new();
    let here = ext.get(k).unwrap_or(&empty);
    let mut out = Pass::default();
    if k == 0 {
        // Layer 0: small parts are tails (auto and manual).
        for part in ops::islands(here) {
            if size(&part).is_some_and(|(x, y)| x <= TAIL_SIZE || y <= TAIL_SIZE) {
                out.tails.push(Tail {
                    area: part,
                    height: h_prev,
                });
            }
        }
        return out;
    }
    if !auto && k > d.enforce_layers {
        return out;
    }
    let lower = ext.get(k - 1).unwrap_or(&empty);
    let delta = if k < d.enforce_layers {
        -0.15 * w
    } else {
        h_prev / theta_tan
    };
    let g = ops::grow_square(lower, delta);
    out.parts = ops::islands(&ops::diff(here, &g));
    if p.s.quirks.detection_guard && out.parts.len() > GUARD_PARTS {
        out.guarded = true;
        return out;
    }
    // Cantilevers: parts reaching far from the supported band.
    let band = ops::grow(&g, (w - delta).max(0.0) + 0.1);
    let mut cant: Vec<&Shapes> = Vec::new();
    for v in &out.parts {
        let b = ops::inter(v, &band);
        if !b.is_empty() && reach(v, &b) > CANTILEVER {
            cant.push(v);
        }
    }
    out.cantilevers = ops::union_many(&cant);
    // Floating parts start sharp tails (auto only).
    if auto {
        for part in ops::islands(here) {
            let touches = ops::overlap(&ops::grow(&part, 0.1 * w), lower);
            if !touches && !ops::grow(&part, -0.1 * w).is_empty() {
                out.tails.push(Tail {
                    area: part,
                    height: 0.0,
                });
            }
        }
    }
    out
}

/// One vertical cluster of overhang parts (spec 2.7).
struct Cluster {
    /// Parts by layer.
    parts: std::collections::BTreeMap<usize, Vec<Shapes>>,
    lo: usize,
    hi: usize,
    outline: Shapes,
    cantilever: bool,
}

/// What bridge removal reads of one region of a layer (spec 2.8 and E1).
#[derive(Debug, Clone, Default)]
pub(crate) struct RegionIn {
    /// Every wall path as extruded (outer and inner walls, no gap fill), as open polylines.
    pub(crate) walls: Vec<Vec<P>>,
    /// Bottom-bridge surfaces after the bridge expansion.
    pub(crate) bridges: Vec<Shapes>,
    /// Width and spacing of the region's wall bridge flow (mm).
    pub(crate) bridge_width: f64,
    pub(crate) bridge_spacing: f64,
}

/// Approximate region inputs from the slices (E1's fallback): the outer wall's center line and each
/// inner wall's, and the bottom areas over the layer below without the expansion.
fn approximate(d: &Detect, slices: &Shapes, below: &Shapes) -> RegionIn {
    let mut walls = Vec::new();
    let mut inset = d.outer_wall_width / 2.0;
    for _ in 0..d.wall_loops.max(1) {
        let ring = ops::grow(slices, -inset);
        if ring.is_empty() {
            break;
        }
        for r in ring.iter().flatten() {
            let mut pl = r.clone();
            if let Some(&f) = pl.first() {
                pl.push(f);
            }
            walls.push(pl);
        }
        inset += d.inner_wall_spacing;
    }
    RegionIn {
        walls,
        bridges: ops::islands(&ops::diff(slices, below)),
        bridge_width: d.bridge_width,
        bridge_spacing: d.bridge_spacing,
    }
}

/// Bridges on a layer (spec 2.8 and E1): straight wall pieces whose ends, extended by a line, land on the
/// layer below and whose span is within the limit, as bands; and bottom-bridge surfaces under the limit
/// in X and Y, whole.
fn bridges(d: &Detect, regions: &[RegionIn], below: &Shapes, w: f64) -> Shapes {
    if below.is_empty() {
        return Vec::new();
    }
    let hair = 0.001;
    let anchor = ops::grow_square(below, 0.5 * w);
    let Some([x0, y0, x1, y1]) = ops::bbox(below) else {
        return Vec::new();
    };
    let m = 10_000_000;
    let frame = vec![vec![vec![
        P::new(x0 - m, y0 - m),
        P::new(x1 + m, y0 - m),
        P::new(x1 + m, y1 + m),
        P::new(x0 - m, y1 + m),
    ]]];
    let outside = ops::diff(&frame, &anchor);
    let mut out: Shapes = Vec::new();
    for region in regions {
        let half = region.bridge_width.max(region.bridge_spacing) / 2.0 + hair;
        let mut bands: Vec<Vec<crate::geom::Point>> = Vec::new();
        for wall in &region.walls {
            for piece in crate::support::clip_inside(wall, &outside) {
                let (Some(&a), Some(&b)) = (piece.first(), piece.last()) else {
                    continue;
                };
                let (dx, dy) = (f64::from(b.x - a.x), f64::from(b.y - a.y));
                let len = dx.m_hypot(dy);
                if len <= 0.0 {
                    continue;
                }
                let straight = piece.windows(2).all(|s| match s {
                    [q, r] => {
                        let (ex, ey) = (f64::from(r.x - q.x), f64::from(r.y - q.y));
                        let el = ex.m_hypot(ey);
                        el <= 0.0 || ((dx * ey - dy * ex) / (len * el)).abs() < 1e-3
                    }
                    _ => true,
                });
                if !straight {
                    continue;
                }
                let ext = w * crate::geom::SCALE;
                let (ux, uy) = (dx / len, dy / len);
                let a2 = ops::to_p(f64::from(a.x) - ux * ext, f64::from(a.y) - uy * ext);
                let b2 = ops::to_p(f64::from(b.x) + ux * ext, f64::from(b.y) + uy * ext);
                if ops::contains(below, a2)
                    && ops::contains(below, b2)
                    && ops::dist(a2, b2) <= d.max_bridge + hair
                {
                    bands.push(vec![
                        crate::geom::Point::new(a2.x, a2.y),
                        crate::geom::Point::new(b2.x, b2.y),
                    ]);
                }
            }
        }
        out = ops::union(&out, &ops::stroke(&bands, half));
        for a in &region.bridges {
            let m = BRIDGE_SIZE_MARGIN;
            if size(a).is_some_and(|(x, y)| x + m < d.max_bridge && y + m < d.max_bridge) {
                out = ops::union(&out, a);
            }
        }
    }
    ops::grow(&out, hair)
}

/// Sharp-tail heights summed as the settings say: single precision in parity mode.
fn add_height(p: &Params, a: f64, b: f64) -> f64 {
    if p.s.quirks.single_precision_tails {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "the reference sums in single precision"
        )]
        let s = a as f32 + b as f32;
        f64::from(s)
    } else {
        // Whole micrometers, so whole millimeters land exactly.
        ((a + b) * 1000.0).round() / 1000.0
    }
}

/// Overhang areas per object layer.
#[allow(clippy::too_many_lines, reason = "the detector's steps in order")]
pub(crate) fn detect(p: &Params, inp: &Input<'_>, d: &Detect) -> Vec<Shapes> {
    let n = inp.models.len();
    let auto = !d.manual;
    let w = p.s.line_width.max(0.05);
    let theta = {
        let t = if p.s.threshold_angle > 0.0 {
            p.s.threshold_angle + 1.0
        } else {
            30.0
        };
        t.min(89.0).to_radians()
    };
    let theta_tan = theta.m_tan();
    let height = |k: usize| -> f64 {
        let top = inp.tops.get(k).copied().unwrap_or(0.0);
        let below = k
            .checked_sub(1)
            .and_then(|b| inp.tops.get(b))
            .copied()
            .unwrap_or(0.0);
        (top - below).max(0.0)
    };
    let idx: Vec<usize> = (0..n).collect();
    let ext: Vec<Shapes> = crate::par::map(&idx, |&l| {
        inp.models.get(l).map_or_else(Vec::new, |s| extrudable(s, w))
    });
    // 2.3 to 2.5, every layer on its own.
    let mut passes: Vec<Pass> = crate::par::map(&idx, |&k| {
        let h_prev = if k == 0 { height(0) } else { height(k - 1) };
        pass(p, d, &ext, k, h_prev, auto, w, theta_tan)
    });
    let guarded = passes.iter().any(|x| x.guarded);
    // 2.6: tails grow upward.
    if auto && !guarded {
        for k in 1..n {
            let (lo, hi) = passes.split_at_mut(k);
            let (Some(prev), Some(cur)) = (lo.last(), hi.first_mut()) else {
                continue;
            };
            if prev.tails.is_empty() {
                continue;
            }
            let prev_refs: Vec<&Shapes> = prev.tails.iter().map(|t| &t.area).collect();
            let prev_all = ops::union_many(&prev_refs);
            let prev_size = size(&prev_all).unwrap_or((0.0, 0.0));
            let first_found: Vec<Shapes> = cur.tails.iter().map(|t| t.area.clone()).collect();
            let empty = Vec::new();
            for part in ops::islands(ext.get(k).unwrap_or(&empty)) {
                if first_found.iter().any(|t| ops::overlap(t, &part)) {
                    continue;
                }
                let q = ops::inter(&part, &prev_all);
                if q.is_empty() {
                    continue;
                }
                if size(&q).is_some_and(|(x, y)| x > TAIL_SIZE && y > TAIL_SIZE) {
                    continue;
                }
                let Some(under) = prev.tails.iter().find(|t| ops::overlap(&t.area, &part)) else {
                    continue;
                };
                let t = add_height(p, height(k), under.height);
                if t > TAIL_HEIGHT {
                    continue;
                }
                let rest = ops::diff(&part, &prev_all);
                let grew = size(&rest)
                    .is_some_and(|(x, y)| x - prev_size.0 > TAIL_GROWTH && y - prev_size.1 > TAIL_GROWTH);
                if grew || !ops::grow(&rest, -TAIL_GROWTH * w).is_empty() {
                    continue;
                }
                cur.tails.push(Tail {
                    area: part,
                    height: t,
                });
            }
        }
    }
    // 2.7: clusters, layer by layer from the bottom.
    let mut clusters: Vec<Cluster> = Vec::new();
    let mut open_prev: Vec<usize> = Vec::new();
    for (k, ps) in passes.iter().enumerate() {
        let mut open_now: Vec<usize> = Vec::new();
        for v in &ps.parts {
            let grown = ops::grow(v, w);
            let gb = ops::bbox(&grown);
            let hit = open_prev.iter().copied().find(|&c| {
                clusters
                    .get(c)
                    .and_then(|cl| k.checked_sub(1).and_then(|b| cl.parts.get(&b)))
                    .is_some_and(|below| {
                        below
                            .iter()
                            .any(|bp| ops::boxes_touch(ops::bbox(bp), gb, 0) && ops::overlap(bp, &grown))
                    })
            });
            let cant = !ps.cantilevers.is_empty() && ops::overlap(v, &ps.cantilevers);
            if let Some((c, cl)) = hit.and_then(|c| clusters.get_mut(c).map(|cl| (c, cl))) {
                let first_here = !cl.parts.contains_key(&k);
                if first_here || !p.s.quirks.one_part_per_cluster_layer {
                    cl.parts.entry(k).or_default().push(v.clone());
                    cl.cantilever |= cant;
                }
                cl.outline = ops::union(&cl.outline, &grown);
                cl.hi = cl.hi.max(k);
                if !open_now.contains(&c) {
                    open_now.push(c);
                }
            } else {
                let mut parts = std::collections::BTreeMap::new();
                parts.insert(k, vec![v.clone()]);
                clusters.push(Cluster {
                    parts,
                    lo: k,
                    hi: k,
                    outline: v.clone(),
                    cantilever: cant,
                });
                open_now.push(clusters.len() - 1);
            }
        }
        open_prev = open_now;
    }
    let mut overhang: Vec<Vec<Shapes>> = vec![Vec::new(); n];
    for cl in &clusters {
        if auto && d.remove_small && !guarded && !cl.cantilever {
            let tail = (cl.lo..=cl.hi).any(|k| {
                passes
                    .get(k)
                    .is_some_and(|ps| ps.tails.iter().any(|t| ops::overlap(&t.area, &cl.outline)))
            });
            if !tail {
                let shrunk = ops::grow(&cl.outline, -w);
                let small = size(&shrunk).is_none_or(|(x, y)| x < 2.0 * w || y < 2.0 * w);
                if small {
                    continue;
                }
            }
        }
        for (&k, ps) in &cl.parts {
            if let Some(o) = overhang.get_mut(k) {
                o.extend(ps.iter().cloned());
            }
        }
    }
    // 2.9 to 2.11, every layer on its own.
    let empty = Vec::new();
    let mut out: Vec<Shapes> = crate::par::map(&idx, |&k| {
        let parts: Vec<&Shapes> = overhang.get(k).map(|v| v.iter().collect()).unwrap_or_default();
        let mut o = ops::union_many(&parts);
        let ps = passes.get(k);
        let mut cant = ps.map(|x| x.cantilevers.clone()).unwrap_or_default();
        let here = ext.get(k).unwrap_or(&empty);
        let lower = k.checked_sub(1).and_then(|b| ext.get(b)).unwrap_or(&empty);
        // Sharp-tail overhangs (2.11 step 1).
        let mut tails: Vec<Shapes> = Vec::new();
        for t in ps.map_or(&[][..], |x| x.tails.as_slice()) {
            if k == 0 {
                tails.push(t.area.clone());
                continue;
            }
            let a = ops::diff(&t.area, &ops::grow(lower, EPS_R));
            #[allow(
                clippy::cast_possible_truncation,
                reason = "a tail height in tenths of a millimeter"
            )]
            let tenth = (10.0 * t.height).floor() as i64;
            if !a.is_empty() && tenth % 5 == 0 {
                tails.push(a);
            }
        }
        let tail_refs: Vec<&Shapes> = tails.iter().collect();
        let mut tail_area = ops::union_many(&tail_refs);
        // 2.9: blockers, critical-only, bridges.
        if let Some(block) = inp.block.get(k).filter(|b| !b.is_empty()) {
            let b = ops::grow(block, 0.2);
            o = ops::diff(&o, &b);
            cant = ops::diff(&cant, &b);
            tail_area = ops::diff(&tail_area, &b);
        }
        if auto && d.critical_only {
            o = cant;
        }
        if d.max_bridge > 0.0 && k >= 1 && !o.is_empty() {
            let slices = inp.models.get(k).unwrap_or(&empty);
            let below = inp.models.get(k - 1).unwrap_or(&empty);
            let regions = match inp.regions {
                Some(f) => f(k),
                None => vec![approximate(d, slices, below)],
            };
            o = ops::diff(&o, &bridges(d, &regions, below, w));
        }
        // 2.10: enforcers.
        if k >= 1
            && let Some(force) = inp.force.get(k).filter(|f| !f.is_empty())
        {
            let new_area = ops::inter(&ops::diff(here, lower), force);
            if !new_area.is_empty() {
                o = ops::union(&o, &ops::diff(&ops::grow(&new_area, 0.8), lower));
            }
        }
        // 2.11: tails, grown for organic trees.
        if !tail_area.is_empty() {
            o = ops::union(&o, &ops::grow(&tail_area, 0.2));
        }
        o
    });
    // Painted enforcement on vertical faces: a small circle on the first layer sliced at or above each
    // point, above layer 0 and inside the object.
    let object = ops::bbox(&inp.models.iter().flatten().cloned().collect::<Shapes>());
    for pt in &inp.vertical_points {
        let zs: &[f64] = if d.slice_z.len() == n {
            &d.slice_z
        } else {
            inp.tops
        };
        let l = zs.partition_point(|&z| z < pt[2] - 1e-9);
        if l == 0 || l >= n {
            continue;
        }
        let at = P::new(crate::geom::mm(pt[0]), crate::geom::mm(pt[1]));
        if !object.is_some_and(|[x0, y0, x1, y1]| at.x >= x0 && at.x <= x1 && at.y >= y0 && at.y <= y1) {
            continue;
        }
        if let Some(o) = out.get_mut(l) {
            *o = ops::union(o, &ops::round_circle(at, 0.5));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::params::{Settings, u};
    use super::*;

    fn input<'a>(models: &'a [Shapes], tops: &'a [f64], none: &'a [Shapes]) -> Input<'a> {
        Input {
            models,
            tops,
            force: none,
            block: none,
            bed: [0.0, 0.0, 200.0, 200.0],
            center: [100.0, 100.0],
            settings: Settings::default(),
            detect: Detect::default(),
            vertical_points: Vec::new(),
            raft_tops: Vec::new(),
            raft_offset: 0.0,
            raft_contact: Vec::new(),
            regions: None,
        }
    }

    fn tops(n: usize) -> Vec<f64> {
        #[allow(clippy::cast_precision_loss, reason = "a test")]
        (0..n).map(|k| 0.2 * (k + 1) as f64).collect()
    }

    #[test]
    fn slope_beyond_threshold_overhangs() {
        // A wall stepping out 0.5 mm per 0.2 mm layer (about 68 deg from vertical) overhangs; one stepping
        // 0.1 mm (27 deg) does not.
        let n = 20;
        let steep: Vec<Shapes> = (0..n)
            .map(|k| {
                #[allow(clippy::cast_precision_loss, reason = "a test")]
                let x = 110.0 + 0.5 * k as f64;
                ops::rect([90.0, 90.0, x, 110.0])
            })
            .collect();
        let gentle: Vec<Shapes> = (0..n)
            .map(|k| {
                #[allow(clippy::cast_precision_loss, reason = "a test")]
                let x = 110.0 + 0.1 * k as f64;
                ops::rect([90.0, 90.0, x, 110.0])
            })
            .collect();
        let t = tops(n);
        let none = vec![Vec::new(); n];
        let p = Params::new(Settings::default());
        let d = Detect {
            remove_small: false,
            ..Detect::default()
        };
        let o = detect(&p, &input(&steep, &t, &none), &d);
        assert!(o.iter().skip(1).all(|l| !l.is_empty()));
        let o = detect(&p, &input(&gentle, &t, &none), &d);
        assert!(o.iter().skip(1).all(Vec::is_empty));
    }

    #[test]
    fn floating_tail_and_small_cluster() {
        // A 1 mm square floating from layer 10: a tail at its bottom, kept although small.
        let n = 15;
        let mut m: Vec<Shapes> = vec![ops::rect([50.0, 50.0, 70.0, 70.0]); n];
        for s in m.iter_mut().skip(10) {
            *s = ops::union(s, &ops::rect([100.0, 100.0, 101.0, 101.0]));
        }
        let t = tops(n);
        let none = vec![Vec::new(); n];
        let p = Params::new(Settings::default());
        let o = detect(&p, &input(&m, &t, &none), &Detect::default());
        let at = o.get(10).cloned().unwrap_or_default();
        assert!(ops::contains(&at, P::new(u(100.5), u(100.5))));
    }

    #[test]
    fn heights_sum_exactly_unless_single_precision() {
        let mut s = Settings::default();
        let p = Params::new(s.clone());
        let mut t = 0.0;
        for _ in 0..5 {
            t = add_height(&p, t, 0.2);
        }
        assert!(((10.0 * t).floor() - 10.0).abs() < 1e-9);
        s.quirks.single_precision_tails = true;
        let p = Params::new(s);
        let mut t = 0.0;
        for _ in 0..5 {
            t = add_height(&p, t, 0.2);
        }
        assert!((t - 1.0).abs() < 1e-6);
    }
}
