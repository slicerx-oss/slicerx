// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Slim, strong and hybrid tree supports, as Orca's `TreeSupport` (Support/TreeSupport.cpp) builds them:
//!
//! 1. Overhangs per layer from the extrudable slices (`detect_overhangs`): the outline beyond the layer
//!    below grown by the threshold step, sharp tails (islands that start in mid-air) every half millimeter,
//!    cantilevers, clusters of tiny overhangs dropped, blockers, enforcers and short bridges.
//! 2. Contact points (`generate_contact_points`) under each overhang part: its sharp corners, points along
//!    its outline every branch distance, and a grid turned 22 degrees inside it.
//! 3. Dropping (`drop_nodes`), layer by layer down: the nodes of each part are joined by a minimum spanning
//!    tree, close neighbors merge, and each node moves one step, out of the part's avoidance area or toward
//!    its neighbors (slim trees weight them by inverse squared distance and pull from the bed up, the others
//!    sum the directions and stay still under 5 mm).
//! 4. Smoothing each branch (`smooth_nodes`), then drawing (`draw_circles`): a circle per node, stretched
//!    along its movement, the roof and the first roof layer from the interface nodes, floors where a branch
//!    rests on the part, trimmed by the part.
//!
//! Coordinates are plate units (`crate::geom::SCALE` per mm); lengths named `_mm` are millimeters.

#![allow(
    clippy::indexing_slicing,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    reason = "a node graph indexed by arena position, and plate coordinates in i64 and f64"
)]

use crate::config::{SupportConfig, SupportStyle};
use crate::fm::Fm as _;
use crate::geom::SCALE;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;
use std::collections::{BTreeMap, HashMap, HashSet};

pub(crate) type Pt = (i64, i64);

const MIN_BRANCH_RADIUS: f64 = 0.4;
const MAX_BRANCH_RADIUS: f64 = 10.0;
const MIN_BRANCH_RADIUS_FIRST_LAYER: f64 = 2.0;
const MAX_BRANCH_RADIUS_FIRST_LAYER: f64 = 12.0;
/// Orca's `g_config_tree_support_collision_resolution`, mm.
const RESOLUTION_MM: f64 = 0.2;
const EPS: f64 = 1e-4;

fn u(mm: f64) -> i32 {
    (mm * SCALE).round() as i32
}

fn to_mm(v: i64) -> f64 {
    v as f64 / SCALE
}

/// One overhang part, or any single island: a shape of the plate's `Shapes`.
type Island = Vec<Vec<IntPoint<i32>>>;

fn islands(s: &Shapes) -> impl Iterator<Item = &Island> {
    s.iter()
}

fn one(i: &Island) -> Shapes {
    vec![i.clone()]
}

fn bbox_of(s: &Shapes) -> Option<[i64; 4]> {
    perimeters::bounds(s).map(|b| [i64::from(b[0]), i64::from(b[1]), i64::from(b[2]), i64::from(b[3])])
}

/// True when `p` is inside `s` (holes excluded).
fn inside(s: &Shapes, p: Pt) -> bool {
    let (Ok(x), Ok(y)) = (i32::try_from(p.0), i32::try_from(p.1)) else {
        return false;
    };
    crate::support::point_in(s, x, y)
}

/// The closest point to `p` on any ring of `s` (Orca's `projection_onto`), or `p` when `s` is empty.
fn projection_onto(s: &Shapes, p: Pt) -> Pt {
    let mut best = p;
    let mut best_d = f64::MAX;
    for ring in s.iter().flat_map(|sh| sh.iter()) {
        let n = ring.len();
        for i in 0..n {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            let (ax, ay, bx, by) = (f64::from(a.x), f64::from(a.y), f64::from(b.x), f64::from(b.y));
            let (vx, vy) = (bx - ax, by - ay);
            let l2 = vx * vx + vy * vy;
            let t = if l2 > 0.0 {
                (((p.0 as f64 - ax) * vx + (p.1 as f64 - ay) * vy) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (qx, qy) = (ax + vx * t, ay + vy * t);
            let d = (qx - p.0 as f64).m_powi(2) + (qy - p.1 as f64).m_powi(2);
            if d < best_d {
                best_d = d;
                best = (qx.round() as i64, qy.round() as i64);
            }
        }
    }
    best
}

/// Squared length in mm².
fn d2_mm(v: Pt) -> f64 {
    to_mm(v.0).m_powi(2) + to_mm(v.1).m_powi(2)
}

/// `v` scaled to `len` internal units (Orca's `normal`), or `v` when it is shorter than a unit.
fn normal(v: Pt, len: f64) -> Pt {
    let l = (v.0 as f64).m_hypot(v.1 as f64);
    if l < 1.0 {
        return v;
    }
    (
        (v.0 as f64 * len / l).round() as i64,
        (v.1 as f64 * len / l).round() as i64,
    )
}

fn add(a: Pt, b: Pt) -> Pt {
    (a.0 + b.0, a.1 + b.1)
}

fn sub(a: Pt, b: Pt) -> Pt {
    (a.0 - b.0, a.1 - b.1)
}

/// Orca's `move_out_expolys`: moves `from` out of `polys` grown by `distance_mm`, by at most `max_mm`.
fn move_out(polys: &Shapes, from: &mut Pt, distance_mm: f64, max_mm: f64) -> bool {
    let dilated = perimeters::offset(polys, u(distance_mm));
    let mut pt = projection_onto(&dilated, *from);
    let out = sub(pt, *from);
    let pt_max = add(*from, normal(out, max_mm * SCALE));
    if d2_mm(out) > max_mm * max_mm {
        pt = pt_max;
    }
    if !inside(&dilated, *from) {
        return true;
    }
    if !inside(polys, *from) {
        *from = pt;
        return true;
    }
    if !inside(polys, pt_max) {
        *from = pt_max;
        return true;
    }
    false
}

/// True when the segment `a`-`b` passes through `s` anywhere.
fn cut_by(s: &Shapes, a: Pt, b: Pt) -> bool {
    let p = |q: Pt| IntPoint::new(q.0 as i32, q.1 as i32);
    !crate::support::clip_inside(&[p(a), p(b)], s).is_empty()
}

/// Orca's `avoid_object_remove_extra_small_parts`: `area` less `avoid`, keeping only the largest piece.
fn largest_piece(area: &Shapes, avoid: &Shapes) -> Shapes {
    let rest = perimeters::difference(area, avoid);
    let best = rest
        .iter()
        .map(|sh| (sh, sh.iter().map(|r| crate::geom::area2_int(r)).sum::<i64>()))
        .max_by_key(|(_, a)| *a);
    match best {
        Some((sh, a)) if a > 0 => vec![sh.clone()],
        _ => Vec::new(),
    }
}

fn simplify(s: &Shapes, tol_mm: f64) -> Shapes {
    let tol = (tol_mm * SCALE) as i64;
    let out: Shapes = s
        .iter()
        .map(|sh| {
            sh.iter()
                .map(|r| perimeters::simplify_ring(r, tol))
                .filter(|r| r.len() >= 3)
                .collect::<Vec<_>>()
        })
        .filter(|sh: &Vec<Vec<IntPoint<i32>>>| !sh.is_empty())
        .collect();
    perimeters::union_all(&[&out])
}

fn overlaps(a: &Shapes, b: &Shapes) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if !perimeters::overlaps(perimeters::bounds(a), perimeters::bounds(b)) {
        return false;
    }
    !perimeters::intersection(a, b).is_empty()
}

fn area_mm2(s: &Shapes) -> f64 {
    s.iter()
        .flat_map(|sh| sh.iter())
        .map(|r| crate::geom::area2_int(r) as f64 / 2.0)
        .sum::<f64>()
        / (SCALE * SCALE)
}

/// Distance from `p` to the nearest edge of any ring of `s`, internal units.
fn distance_to(s: &Shapes, p: Pt) -> f64 {
    let q = projection_onto(s, p);
    ((q.0 - p.0) as f64).m_hypot((q.1 - p.1) as f64)
}

/// What the tree planner reads.
pub(crate) struct TreeIn<'a> {
    pub(crate) models: &'a [Shapes],
    /// Top and thickness of each object layer, mm.
    pub(crate) tops: &'a [f64],
    pub(crate) thickness: &'a [f64],
    pub(crate) cfg: &'a SupportConfig,
    /// The object's line width (`line_width`), the support line width and the nozzle, mm.
    pub(crate) line_width: f64,
    pub(crate) support_width: f64,
    pub(crate) force: &'a [Shapes],
    pub(crate) block: &'a [Shapes],
    /// The object's box in plate coordinates, mm, and the bed rectangle.
    pub(crate) object: [f64; 4],
    pub(crate) bed: [f64; 4],
    /// `support_critical_regions_only`, the first layer's gap (`support_object_first_layer_gap`), the base
    /// pattern (Orca's support base pattern name) and the minimum layer height, mm.
    pub(crate) critical_only: bool,
    pub(crate) first_layer_gap: f64,
    pub(crate) min_layer_height: f64,
    pub(crate) raft_first_layer_expansion: f64,
    /// `independent_support_layer_height`, and the thickest support layer (Orca's `max_suport_layer_height`), mm.
    pub(crate) independent: bool,
    pub(crate) max_layer_height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Detected,
    Enforced,
    SharpTail,
}

/// Overhangs over consecutive layers that touch (Orca's `OverhangCluster`).
struct Cluster {
    layer_part: BTreeMap<usize, Island>,
    /// The first part and the grown parts that joined it; their union is the cluster's area.
    pieces: Vec<Shapes>,
    bbox: Option<[i32; 4]>,
    min: usize,
    max: usize,
    cantilever: bool,
    small: bool,
}

/// The overhangs of each layer, as separate parts with their kind.
struct Overhangs {
    parts: Vec<Vec<(Island, Kind)>>,
    sharp_tails: Vec<Vec<(Island, f64)>>,
    extrudable: Vec<Shapes>,
}

/// One layer against the one below in `detect_overhangs`: its overhang parts, the sharp tails it starts and
/// its cantilevers.
struct Scan {
    parts: Vec<Island>,
    tails: Vec<(Island, f64)>,
    cantilevers: Shapes,
}

/// Orca's `TreeSupport::detect_overhangs`.
#[allow(clippy::too_many_lines, reason = "one pass, in Orca's order")]
fn detect_overhangs(inp: &TreeIn<'_>) -> Overhangs {
    let cfg = inp.cfg;
    let n = inp.models.len();
    let ew = inp.line_width;
    let ews = u(ew);
    let auto = !cfg.manual;
    let enforce_layers = cfg.enforce_layers as usize;
    let thresh = if cfg.threshold_angle > EPS {
        cfg.threshold_angle + 1.0
    } else {
        30.0
    }
    .min(89.0);
    let tan_t = thresh.to_radians().m_tan();
    let length_well = 6.0 * SCALE;
    let mut detect_tails = true;
    let mut remove_small = cfg.remove_small_overhang;
    // The extrudable slices: thinner than a line is dropped, details kept.
    let extrudable: Vec<Shapes> = crate::par::map(inp.models, |m| {
        perimeters::intersection(m, &perimeters::offset(&perimeters::offset(m, -ews / 2), ews))
    });
    let empty: Shapes = Vec::new();
    let mut overhangs: Vec<Vec<Island>> = vec![Vec::new(); n];
    let mut sharp_tails: Vec<Vec<(Island, f64)>> = vec![Vec::new(); n];
    let mut cantilevers: Vec<Shapes> = vec![Vec::new(); n];
    if let Some(here) = extrudable.first() {
        for sl in islands(here) {
            if let Some(b) = bbox_of(&one(sl)) {
                let small = !((b[2] - b[0]) as f64 > length_well && (b[3] - b[1]) as f64 > length_well);
                if small {
                    sharp_tails[0].push((sl.clone(), inp.thickness.first().copied().unwrap_or(0.2)));
                }
            }
        }
    }
    // Each layer against the one below, in parallel: its overhang parts, the sharp tails it would start while
    // tails are still detected, and its cantilevers. Then in layer order, as Orca: a layer with over 100 parts
    // turns tail detection and small-overhang removal off for the layers above it, and has no tails or
    // cantilevers itself.
    let scans: Vec<Option<Scan>> =
        crate::par::map_range(1..u32::try_from(n.max(1)).unwrap_or(u32::MAX), |i| {
            let i = i as usize;
            if !auto && i > enforce_layers {
                return None;
            }
            let here = &extrudable[i];
            let lower = &extrudable[i - 1];
            let lower_h = inp.thickness.get(i - 1).copied().unwrap_or(0.2);
            let lower_offset = if i < enforce_layers {
                -0.15 * ew
            } else {
                lower_h / tan_t
            };
            let lower_grown = perimeters::offset(lower, u(lower_offset));
            let parts: Vec<Island> = perimeters::difference(here, &lower_grown).into_iter().collect();
            let mut scan = Scan {
                parts,
                tails: Vec::new(),
                cantilevers: Vec::new(),
            };
            if scan.parts.len() > 100 {
                return Some(scan);
            }
            if auto {
                for ex in islands(here) {
                    let e = one(ex);
                    if !overlaps(&perimeters::offset(&e, u(0.1 * ew)), lower)
                        && !perimeters::offset(&e, -u(0.1 * ew)).is_empty()
                    {
                        scan.tails.push((ex.clone(), 0.0));
                    }
                }
            }
            // Cantilevers: overhang parts whose farthest point is over 3 mm from where they rest.
            let rest = perimeters::offset(&lower_grown, u((ew - lower_offset).max(0.0) + 0.1));
            for part in &scan.parts {
                let boundary = perimeters::intersection(&one(part), &rest);
                if boundary.is_empty() {
                    continue;
                }
                let far = part.first().map_or(0.0, |c| {
                    c.iter()
                        .map(|p| distance_to(&boundary, (i64::from(p.x), i64::from(p.y))))
                        .fold(0.0, f64::max)
                });
                if far > 3.0 * SCALE {
                    scan.cantilevers.push(part.clone());
                }
            }
            Some(scan)
        });
    for (k, scan) in scans.into_iter().enumerate() {
        let i = k + 1;
        let Some(scan) = scan else { continue };
        overhangs[i] = scan.parts;
        if overhangs[i].len() > 100 {
            detect_tails = false;
            remove_small = false;
            continue;
        }
        if auto && detect_tails {
            sharp_tails[i] = scan.tails;
        }
        cantilevers[i] = scan.cantilevers;
    }
    // Sharp tails that keep going up, until they are wide, tall or join something bigger.
    if auto && detect_tails {
        for i in 1..n {
            let lower_tails = sharp_tails[i - 1].clone();
            if lower_tails.is_empty() {
                continue;
            }
            let lower_tail_shapes: Shapes = lower_tails.iter().map(|(t, _)| t.clone()).collect();
            let lt = perimeters::union_all(&[&lower_tail_shapes]);
            for ex in islands(&extrudable[i]) {
                let e = one(ex);
                let supported = perimeters::intersection(&e, &lt);
                if supported.is_empty() {
                    continue;
                }
                let Some(b) = bbox_of(&supported) else { continue };
                if (b[2] - b[0]) as f64 > length_well && (b[3] - b[1]) as f64 > length_well {
                    continue;
                }
                let mut accum = inp.thickness.get(i).copied().unwrap_or(0.2);
                for (t, h) in &lower_tails {
                    if overlaps(&one(t), &e) {
                        accum += h;
                        break;
                    }
                }
                if accum > 16.0 {
                    continue;
                }
                let new_part = perimeters::difference(&e, &lt);
                let grows = match (bbox_of(&new_part), bbox_of(&lt)) {
                    (Some(a), Some(c)) => {
                        let (dx, dy) = ((a[2] - a[0]) - (c[2] - c[0]), (a[3] - a[1]) - (c[3] - c[1]));
                        dx as f64 > 5.0 * SCALE && dy as f64 > 5.0 * SCALE
                    }
                    _ => false,
                };
                if grows || !perimeters::offset(&new_part, -u(5.0 * ew)).is_empty() {
                    continue;
                }
                sharp_tails[i].push((ex.clone(), accum));
            }
        }
    }
    // Clusters of overhangs over consecutive layers; small ones are dropped.
    let mut clusters: Vec<Cluster> = Vec::new();
    for i in 0..n {
        for part in &overhangs[i] {
            let mut found = None;
            // The part grown by a line width, worked out once for every cluster it is tried against.
            let mut grown: Option<Shapes> = None;
            for (ci, c) in clusters.iter_mut().enumerate() {
                if i < 1 {
                    break;
                }
                let Some(prev) = c.layer_part.get(&(i - 1)) else {
                    continue;
                };
                let dil = grown.get_or_insert_with(|| perimeters::offset(&one(part), ews));
                if dil.is_empty() {
                    continue;
                }
                let bb = perimeters::bounds(dil);
                if !perimeters::overlaps(c.bbox, bb) {
                    continue;
                }
                if overlaps(&one(prev), dil) {
                    c.layer_part.entry(i).or_insert_with(|| part.clone());
                    // The union's box is the box of its pieces, so the union waits until the area is read.
                    c.bbox = merge_bounds(c.bbox, perimeters::bounds(dil));
                    c.pieces.push(dil.clone());
                    c.min = c.min.min(i);
                    c.max = c.max.max(i);
                    found = Some(ci);
                    break;
                }
            }
            let ci = found.unwrap_or_else(|| {
                let m = one(part);
                let mut layer_part = BTreeMap::new();
                layer_part.insert(i, part.clone());
                clusters.push(Cluster {
                    layer_part,
                    bbox: perimeters::bounds(&m),
                    pieces: vec![m],
                    min: i,
                    max: i,
                    cantilever: false,
                    small: false,
                });
                clusters.len() - 1
            });
            if overlaps(&one(part), &cantilevers[i]) {
                clusters[ci].cantilever = true;
            }
        }
    }
    if auto && remove_small {
        let small: Vec<bool> = crate::par::map(&clusters, |c| {
            let refs: Vec<&Shapes> = c.pieces.iter().collect();
            let merged = perimeters::union_all(&refs);
            let tail = (c.min..=c.max).any(|l| {
                let t: Shapes = sharp_tails[l].iter().map(|(s, _)| s.clone()).collect();
                overlaps(&t, &merged)
            });
            if tail || c.cantilever {
                return false;
            }
            let erode = perimeters::offset(&merged, -ews);
            match bbox_of(&erode) {
                Some(b) => {
                    ((b[2] - b[0]) as f64) < 2.0 * f64::from(ews)
                        || ((b[3] - b[1]) as f64) < 2.0 * f64::from(ews)
                }
                None => true,
            }
        });
        for (c, s) in clusters.iter_mut().zip(small) {
            c.small = s;
        }
    }
    let mut kept: Vec<Shapes> = vec![Vec::new(); n];
    for c in clusters.iter().filter(|c| !c.small) {
        for (l, p) in &c.layer_part {
            kept[*l].push(p.clone());
        }
    }
    // Blockers, critical regions only, bridges, enforcers and sharp tails.
    let parts: Vec<Vec<(Island, Kind)>> =
        crate::par::map_range(0..u32::try_from(n).unwrap_or(u32::MAX), |i| {
            let i = i as usize;
            let mut tail_parts: Shapes = Vec::new();
            if i == 0 {
                tail_parts = sharp_tails[0].iter().map(|(s, _)| s.clone()).collect();
            } else {
                let lower_exp = perimeters::offset(&extrudable[i - 1], u(0.0125));
                for (t, h) in &sharp_tails[i] {
                    let a = perimeters::difference(&one(t), &lower_exp);
                    if !a.is_empty() && ((h * 10.0) as i64) % 5 == 0 {
                        tail_parts.extend(a);
                    }
                }
            }
            let mut detected = kept[i].clone();
            let mut cant = cantilevers[i].clone();
            if let Some(b) = inp.block.get(i).filter(|b| !b.is_empty()) {
                let bl = perimeters::offset(&perimeters::union_all(&[b]), u(RESOLUTION_MM));
                detected = perimeters::difference(&detected, &bl);
                cant = perimeters::difference(&cant, &bl);
                tail_parts = perimeters::difference(&tail_parts, &bl);
            }
            if inp.critical_only && auto {
                detected.clone_from(&cant);
            }
            if cfg.max_bridge_length > 0.0 && !detected.is_empty() && i > 0 {
                let br = bridges(inp, i, ew, cfg.max_bridge_length);
                if !br.is_empty() {
                    detected = perimeters::difference(&detected, &br);
                }
            }
            let mut list: Vec<(Island, Kind)> = detected.into_iter().map(|p| (p, Kind::Detected)).collect();
            if i > 0
                && let Some(f) = inp.force.get(i).filter(|f| !f.is_empty())
            {
                let lower = extrudable.get(i - 1).unwrap_or(&empty);
                let enforced = perimeters::intersection(&perimeters::difference(&extrudable[i], lower), f);
                if !enforced.is_empty() {
                    let grown = perimeters::difference(&perimeters::offset(&enforced, u(0.8)), lower);
                    list.extend(grown.into_iter().map(|p| (p, Kind::Enforced)));
                }
            }
            list.extend(tail_parts.into_iter().map(|p| (p, Kind::SharpTail)));
            list
        });
    Overhangs {
        parts,
        sharp_tails,
        extrudable,
    }
}

/// The overhangs of every layer as Orca's organic trees read them (`layer->loverhangs` with their types): the
/// detected and enforced parts, and the sharp tails apart.
pub(crate) fn overhang_areas(inp: &TreeIn<'_>) -> Vec<(Shapes, Shapes)> {
    detect_overhangs(inp)
        .parts
        .into_iter()
        .map(|list| {
            let mut parts: Shapes = Vec::new();
            let mut tails: Shapes = Vec::new();
            for (p, k) in list {
                if k == Kind::SharpTail {
                    tails.push(p);
                } else {
                    parts.push(p);
                }
            }
            (parts, tails)
        })
        .collect()
}

/// Bridges a tree branch need not hold up (Orca's `PrintObject::remove_bridges_from_contacts` without breaking
/// long bridges): straight wall runs over air that rest on the layer below at both ends and are no longer than
/// `max_mm`, and bottom surfaces over air inside the walls whose box is shorter than `max_mm` both ways.
fn bridges(inp: &TreeIn<'_>, i: usize, fw_mm: f64, max_mm: f64) -> Shapes {
    let here = &inp.models[i];
    let lower = &inp.models[i - 1];
    let (loops, outer, inner, _) = inp.cfg.walls;
    let grown = perimeters::offset(lower, u(0.5 * fw_mm));
    let mut out: Vec<Shapes> = Vec::new();
    let half = 0.5 * outer.max(inner) * SCALE + 10.0 / 100.0;
    for k in 0..loops.max(1) {
        let inset = if k == 0 {
            0.5 * outer
        } else {
            outer + inner * (f64::from(k) - 0.5)
        };
        for ring in perimeters::offset(here, -u(inset)).iter().flat_map(|s| s.iter()) {
            let m = ring.len();
            for e in 0..m {
                let (a, b) = (ring[e], ring[(e + 1) % m]);
                let pa = (i64::from(a.x), i64::from(a.y));
                let pb = (i64::from(b.x), i64::from(b.y));
                for piece in crate::support::clip_inside(
                    &[a, b],
                    &perimeters::difference(&vec![vec![box_around(pa, pb)]], &grown),
                ) {
                    let (Some(p), Some(q)) = (piece.first(), piece.last()) else {
                        continue;
                    };
                    let (p, q) = ((i64::from(p.x), i64::from(p.y)), (i64::from(q.x), i64::from(q.y)));
                    let len = ((q.0 - p.0) as f64).m_hypot((q.1 - p.1) as f64);
                    if len < 1.0 {
                        continue;
                    }
                    let fw = fw_mm * SCALE;
                    let (ux, uy) = ((q.0 - p.0) as f64 / len * fw, (q.1 - p.1) as f64 / len * fw);
                    let p2 = ((p.0 as f64 - ux) as i64, (p.1 as f64 - uy) as i64);
                    let q2 = ((q.0 as f64 + ux) as i64, (q.1 as f64 + uy) as i64);
                    if !(inside(lower, p2) && inside(lower, q2)) {
                        continue;
                    }
                    if len + 2.0 * fw > max_mm * SCALE + 10.0 / 100.0 {
                        continue;
                    }
                    out.push(vec![vec![band(p2, q2, half)]]);
                }
            }
        }
    }
    // Bottom surfaces over air inside the walls, short both ways.
    let walls_mm = outer + inner * f64::from(loops.saturating_sub(1));
    let fill = perimeters::offset(here, -u(walls_mm));
    for part in perimeters::difference(&fill, lower) {
        if let Some(b) = bbox_of(&one(&part))
            && ((b[2] - b[0]) as f64) < max_mm * SCALE
            && ((b[3] - b[1]) as f64) < max_mm * SCALE
        {
            out.push(one(&part));
        }
    }
    let refs: Vec<&Shapes> = out.iter().collect();
    perimeters::union_all(&refs)
}

/// The box around two boxes.
fn merge_bounds(a: Option<[i32; 4]>, b: Option<[i32; 4]>) -> Option<[i32; 4]> {
    match (a, b) {
        (Some(a), Some(b)) => Some([a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]),
        (a, None) => a,
        (None, b) => b,
    }
}

fn box_around(a: Pt, b: Pt) -> Vec<IntPoint<i32>> {
    let (x0, x1) = (a.0.min(b.0) - 2, a.0.max(b.0) + 2);
    let (y0, y1) = (a.1.min(b.1) - 2, a.1.max(b.1) + 2);
    let p = |x: i64, y: i64| IntPoint::new(x as i32, y as i32);
    vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]
}

fn band(p: Pt, q: Pt, half: f64) -> Vec<IntPoint<i32>> {
    let (dx, dy) = ((q.0 - p.0) as f64, (q.1 - p.1) as f64);
    let len = dx.m_hypot(dy).max(1.0);
    let (nx, ny) = (-dy / len * half, dx / len * half);
    let at = |x: i64, y: i64, s: f64| {
        IntPoint::new(
            (x as f64 + nx * s).round() as i32,
            (y as f64 + ny * s).round() as i32,
        )
    };
    vec![
        at(p.0, p.1, -1.0),
        at(q.0, q.1, -1.0),
        at(q.0, q.1, 1.0),
        at(p.0, p.1, 1.0),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeType {
    Circle,
    Polygon,
}

/// Orca's `SupportNode`.
#[derive(Debug, Clone)]
#[allow(clippy::struct_excessive_bools, reason = "Orca's node flags")]
struct Node {
    pos: Pt,
    movement: Pt,
    distance_to_top: i32,
    dist_mm: f64,
    radius: f64,
    max_move: f64,
    kind: NodeType,
    is_processed: bool,
    extra_wall: bool,
    sharp_tail: bool,
    valid: bool,
    overhang: Shapes,
    skin: Pt,
    roof_below: i32,
    to_bed: bool,
    parent: Option<usize>,
    parents: Vec<usize>,
    child: Option<usize>,
    merged: Vec<usize>,
    print_z: f64,
    height: f64,
}

/// A support layer: its top, its thickness and the object layer it is planned against (Orca's
/// `LayerHeightData`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct LayerH {
    pub(crate) z: f64,
    pub(crate) h: f64,
    pub(crate) obj: usize,
}

/// The settings the dropping and drawing read.
#[allow(clippy::struct_excessive_bools, reason = "the style switches Orca reads")]
struct Params {
    base_radius: f64,
    diameter_scale: f64,
    tan_angle: f64,
    support_width: f64,
    slim: bool,
    strong: bool,
    hybrid: bool,
    top_z: f64,
    top_layers: usize,
    xy: f64,
    on_bed_only: bool,
}

impl Params {
    /// Orca's `TreeSupport::calc_branch_radius` by distance to the top, mm.
    fn calc_radius(&self, mm_to_top: f64) -> f64 {
        let tip = self.base_radius;
        let r = if mm_to_top > tip {
            self.base_radius + (mm_to_top - tip) * self.diameter_scale
        } else {
            mm_to_top
        };
        let r = r.clamp(MIN_BRANCH_RADIUS, MAX_BRANCH_RADIUS);
        if self.top_layers > 0 {
            r.max(self.base_radius)
        } else {
            r
        }
    }
}

/// The node arena and the nodes of each layer.
struct Nodes {
    all: Vec<Node>,
    layers: Vec<Vec<usize>>,
}

impl Nodes {
    #[allow(clippy::too_many_arguments, reason = "Orca's create_node")]
    fn create(
        &mut self,
        pos: Pt,
        distance_to_top: i32,
        _obj_layer: usize,
        roof_below: i32,
        to_bed: bool,
        parent: Option<usize>,
        print_z: f64,
        height: f64,
        dist_mm: f64,
        radius: f64,
        diameter_scale: f64,
    ) -> usize {
        let idx = self.all.len();
        let mut n = Node {
            pos,
            movement: (0, 0),
            distance_to_top,
            dist_mm,
            radius,
            max_move: 0.0,
            kind: NodeType::Circle,
            is_processed: false,
            extra_wall: false,
            sharp_tail: false,
            valid: true,
            overhang: Vec::new(),
            skin: (0, 0),
            roof_below,
            to_bed,
            parent,
            parents: Vec::new(),
            child: None,
            merged: Vec::new(),
            print_z,
            height,
        };
        if let Some(p) = parent {
            let par = self.all[p].clone();
            n.parents.push(p);
            n.kind = par.kind;
            n.overhang.clone_from(&par.overhang);
            if n.dist_mm == 0.0 {
                n.dist_mm = par.dist_mm + par.height;
            }
            if n.radius == 0.0 && par.radius > 0.0 {
                n.radius = par.radius + (n.dist_mm - par.dist_mm) * diameter_scale;
            }
            n.sharp_tail = par.sharp_tail;
            n.skin = par.skin;
            n.movement = sub(pos, par.pos);
            self.all[p].child = Some(idx);
            for m in par.merged {
                self.all[m].child = Some(idx);
                n.parents.push(m);
            }
        }
        self.all.push(n);
        idx
    }

    fn radius(&mut self, i: usize, p: &Params) -> f64 {
        if self.all[i].radius == 0.0 {
            self.all[i].radius = p.calc_radius(self.all[i].dist_mm);
        }
        self.all[i].radius
    }

    /// Orca's `get_max_move_dist`, mm.
    fn max_move(&mut self, i: usize, p: &Params) -> f64 {
        if self.all[i].max_move == 0.0 {
            self.radius(i, p);
            self.all[i].max_move = (p.tan_angle * self.all[i].height).min(p.support_width);
        }
        self.all[i].max_move
    }
}

/// Collision and avoidance areas per radius and layer (Orca's `TreeSupportData`).
struct Volumes {
    outlines: Vec<Shapes>,
    outlines_below: Vec<Shapes>,
    max_move: Vec<f64>,
    xy: f64,
    collision: HashMap<(i64, usize), Shapes>,
    avoidance: HashMap<(i64, usize), Shapes>,
}

impl Volumes {
    fn new(models: &[Shapes], thickness: &[f64], branch_angle_deg: f64, xy: f64) -> Self {
        let scale = branch_angle_deg.to_radians().m_tan();
        let outlines: Vec<Shapes> = models.iter().map(|m| simplify(m, RESOLUTION_MM)).collect();
        let mut below: Vec<Shapes> = Vec::with_capacity(outlines.len());
        for o in &outlines {
            let next = match below.last() {
                Some(b) => perimeters::union_all(&[b, o]),
                None => o.clone(),
            };
            below.push(next);
        }
        Self {
            max_move: thickness.iter().map(|h| h * scale).collect(),
            outlines,
            outlines_below: below,
            xy,
            collision: HashMap::new(),
            avoidance: HashMap::new(),
        }
    }

    /// Radius rounded up to the collision resolution, as a key in tenths of a micrometer.
    fn ceil(r: f64) -> (f64, i64) {
        let f = (r / RESOLUTION_MM).floor();
        let rem = r - RESOLUTION_MM * f;
        let c = if rem > EPS { r + RESOLUTION_MM - rem } else { r };
        (c, (c * 1e4).round() as i64)
    }

    fn collision(&mut self, r: f64, layer: usize) -> Shapes {
        let (c, key) = Self::ceil(r);
        if let Some(s) = self.collision.get(&(key, layer)) {
            return s.clone();
        }
        let empty = Vec::new();
        let o = self.outlines.get(layer).unwrap_or(&empty);
        let s = simplify(&perimeters::offset(o, u(c + self.xy)), RESOLUTION_MM);
        self.collision.insert((key, layer), s.clone());
        s
    }

    fn avoidance(&mut self, r: f64, layer: usize) -> Shapes {
        let (_, key) = Self::ceil(r);
        if let Some(s) = self.avoidance.get(&(key, layer)) {
            return s.clone();
        }
        // Build up from the lowest layer missing, so there is no deep recursion.
        let mut start = layer;
        while start > 0 && !self.avoidance.contains_key(&(key, start - 1)) {
            start -= 1;
        }
        for l in start..=layer {
            let mut a: Shapes = if l > 0 {
                let below = self.avoidance.get(&(key, l - 1)).cloned().unwrap_or_default();
                perimeters::offset(&below, -u(self.max_move.get(l - 1).copied().unwrap_or(0.0)))
            } else {
                Vec::new()
            };
            let col = self.collision(r, l);
            a = perimeters::union_all(&[&a, &col]);
            self.avoidance.insert((key, l), a);
        }
        self.avoidance.get(&(key, layer)).cloned().unwrap_or_default()
    }
}

/// Orca's `generate_contact_points`: the contact nodes of each layer, on the layer under the overhang.
#[allow(clippy::too_many_lines, reason = "one pass, in Orca's order")]
fn contact_points(inp: &TreeIn<'_>, oh: &Overhangs, p: &Params, nodes: &mut Nodes) {
    let n = inp.models.len();
    let t = &inp.cfg.tree_settings;
    let point_spread = t.branch_distance * SCALE;
    let max_bridge = inp.cfg.max_bridge_length * SCALE;
    let radius_scaled = (p.base_radius * SCALE) as i64;
    // A grid over the object's box, turned 22 degrees about its middle.
    let o = inp.object;
    let (bx0, by0, bx1, by1) = (
        (o[0] * SCALE) as i64,
        (o[1] * SCALE) as i64,
        (o[2] * SCALE) as i64,
        (o[3] * SCALE) as i64,
    );
    let center = (i64::midpoint(bx0, bx1), i64::midpoint(by0, by1));
    let (sn, cs) = 22.0_f64.to_radians().m_sin_cos();
    let (w, h) = ((bx1 - bx0) as f64, (by1 - by0) as f64);
    let rd = (f64::midpoint(w * cs, h * sn), f64::midpoint(w * sn, h * cs));
    let step = point_spread.max(max_bridge / 2.0).max(1.0);
    let mut grid: Vec<Pt> = Vec::new();
    let mut x = -rd.0;
    while x < rd.0 {
        let mut y = -rd.1;
        while y < rd.1 {
            let q = (
                (x * cs - y * sn).round() as i64 + center.0,
                (x * sn + y * cs).round() as i64 + center.1,
            );
            if q.0 >= bx0 && q.0 <= bx1 && q.1 >= by0 && q.1 <= by1 {
                grid.push(q);
            }
            y += step;
        }
        x += step;
    }
    let layer_h = inp.thickness.first().copied().unwrap_or(0.2);
    let gap_layers = i32::from(p.top_z > 0.0);
    let z_top_layers = ((p.top_z / layer_h - 1e-9).ceil() as usize) + 1;
    let roof_layers = p.top_layers;
    if n <= z_top_layers + 1 {
        return;
    }
    let thresh_big = 100.0; // mm², Orca's thresh_big_overhang
    for layer in 1..n {
        let bottom_z = inp.tops[layer] - inp.thickness[layer];
        let mut seen: HashSet<Pt> = HashSet::new();
        let mut insert = |nodes: &mut Nodes,
                          pt: Pt,
                          overhang: &Shapes,
                          radius: f64,
                          force: bool,
                          iface: bool,
                          sharp: bool|
         -> Option<usize> {
            // C++ integer division truncates toward zero, in object coordinates.
            let rel = sub(pt, center);
            let cell = radius_scaled + 1;
            let key = (rel.0 / cell, rel.1 / cell);
            if !force && seen.contains(&key) {
                return None;
            }
            seen.insert(key);
            let roof = if iface {
                roof_layers.saturating_sub(1) as i32
            } else {
                0
            };
            let id = nodes.create(
                pt,
                -gap_layers,
                layer - 1,
                roof,
                true,
                None,
                bottom_z,
                p.top_z,
                0.0,
                radius,
                p.diameter_scale,
            );
            nodes.all[id].overhang.clone_from(overhang);
            nodes.all[id].sharp_tail = sharp;
            nodes.layers[layer - 1].push(id);
            Some(id)
        };
        for (part, kind) in &oh.parts[layer] {
            let sharp = *kind == Kind::SharpTail;
            let part_s = one(part);
            let mut regular: Shapes = part_s.clone();
            if p.hybrid && area_mm2(&part_s) > thresh_big && !sharp {
                let below = oh_below(inp, layer);
                let reg =
                    perimeters::offset(&perimeters::intersection(&part_s, &below), radius_scaled as i32);
                let normal_part = perimeters::difference(&part_s, &reg);
                if area_mm2(&normal_part) > thresh_big {
                    for ov in &normal_part {
                        let os = one(ov);
                        let Some(b) = bbox_of(&os) else { continue };
                        let r = to_mm((((b[2] - b[0]) as f64).m_hypot((b[3] - b[1]) as f64) / 2.0) as i64);
                        let c = (i64::midpoint(b[0], b[2]), i64::midpoint(b[1], b[3]));
                        if let Some(id) = insert(nodes, c, &os, r, true, true, sharp) {
                            nodes.all[id].kind = NodeType::Polygon;
                        }
                    }
                    regular = reg;
                }
            }
            for ov in &regular {
                let os = one(ov);
                let iface = area_mm2(&os) > 1.0 && !sharp;
                let Some(b) = bbox_of(&os) else { continue };
                let r = (to_mm((((b[2] - b[0]) as f64).m_hypot((b[3] - b[1]) as f64) / 2.0) as i64))
                    .clamp(MIN_BRANCH_RADIUS, p.base_radius);
                // Corners sharper than 135 degrees.
                if let Some(c) = ov.first() {
                    let m = c.len();
                    for k in 0..m {
                        let pt = c[k];
                        let a = c[(k + m - 1) % m];
                        let bb = c[(k + 1) % m];
                        let v1 = (f64::from(pt.x - a.x), f64::from(pt.y - a.y));
                        let v2 = (f64::from(pt.x - bb.x), f64::from(pt.y - bb.y));
                        let (l1, l2) = (v1.0.m_hypot(v1.1), v2.0.m_hypot(v2.1));
                        if l1 > 0.0 && l2 > 0.0 && (v1.0 * v2.0 + v1.1 * v2.1) / (l1 * l2) > -0.7 {
                            let _ = insert(
                                nodes,
                                (i64::from(pt.x), i64::from(pt.y)),
                                &os,
                                r,
                                false,
                                iface,
                                sharp,
                            );
                        }
                    }
                }
                // Points along each outline every branch distance.
                for ring in ov {
                    let m = ring.len();
                    if m < 2 {
                        continue;
                    }
                    let mut pts: Vec<(f64, f64)> =
                        ring.iter().map(|q| (f64::from(q.x), f64::from(q.y))).collect();
                    pts.push(pts[0]);
                    let lens: Vec<f64> = pts
                        .windows(2)
                        .map(|s| (s[1].0 - s[0].0).m_hypot(s[1].1 - s[0].1))
                        .collect();
                    let circ: f64 = lens.iter().sum();
                    if circ <= 0.0 {
                        continue;
                    }
                    let stepf = point_spread / circ;
                    let mut d = 0.0;
                    while d < 1.0 {
                        let mut target = d * circ;
                        let mut q = pts[0];
                        for (s, l) in lens.iter().enumerate() {
                            if target <= *l || s + 1 == lens.len() {
                                let tt = if *l > 0.0 { (target / l).min(1.0) } else { 0.0 };
                                q = (
                                    pts[s].0 + (pts[s + 1].0 - pts[s].0) * tt,
                                    pts[s].1 + (pts[s + 1].1 - pts[s].1) * tt,
                                );
                                break;
                            }
                            target -= l;
                        }
                        let _ = insert(
                            nodes,
                            (q.0.round() as i64, q.1.round() as i64),
                            &os,
                            r,
                            false,
                            iface,
                            sharp,
                        );
                        if stepf <= 0.0 {
                            break;
                        }
                        d += stepf;
                    }
                }
                if sharp {
                    continue;
                }
                // The grid inside.
                let inner = perimeters::offset(&os, -(radius_scaled as i32));
                for &c in &grid {
                    if c.0 >= b[0] && c.0 <= b[2] && c.1 >= b[1] && c.1 <= b[3] && inside(&inner, c) {
                        let _ = insert(nodes, c, &os, r, false, iface, sharp);
                    }
                }
            }
        }
    }
}

/// The union of the outlines up to the layer under `layer`, simplified (Orca's `m_layer_outlines_below`).
fn oh_below(inp: &TreeIn<'_>, layer: usize) -> Shapes {
    let refs: Vec<&Shapes> = inp.models.iter().take(layer).collect();
    simplify(&perimeters::union_all(&refs), RESOLUTION_MM)
}

/// The neighbors of each point in the minimum spanning tree of `pts` (Orca's `MinimumSpanningTree`, Prim's
/// method from the first point).
fn spanning_tree(pts: &[Pt]) -> HashMap<Pt, Vec<Pt>> {
    let mut adj: HashMap<Pt, Vec<Pt>> = HashMap::new();
    if pts.is_empty() {
        return adj;
    }
    if pts.len() == 1 {
        adj.insert(pts[0], Vec::new());
        return adj;
    }
    let mut best: Vec<(f64, usize)> = pts.iter().map(|q| (d2_mm(sub(*q, pts[0])), 0)).collect();
    let mut done = vec![false; pts.len()];
    done[0] = true;
    let mut count = 1;
    while count < pts.len() {
        let Some(k) = (0..pts.len())
            .filter(|&j| !done[j])
            .min_by(|&a, &b| best[a].0.total_cmp(&best[b].0))
        else {
            break;
        };
        done[k] = true;
        count += 1;
        let other = pts[best[k].1];
        adj.entry(pts[k]).or_default().push(other);
        adj.entry(other).or_default().push(pts[k]);
        for j in 0..pts.len() {
            if !done[j] {
                let d = d2_mm(sub(pts[k], pts[j]));
                if d < best[j].0 {
                    best[j] = (d, k);
                }
            }
        }
    }
    adj
}

/// Orca's `TreeSupport::drop_nodes`: moves every node down one layer at a time.
#[allow(clippy::too_many_lines, reason = "one pass, in Orca's order")]
/// Below this height slim branches merge more readily, mm.
const SLIM_LOW_MERGE_Z: f64 = 5.0;
/// How close slim branches near the bed must be to merge, as a share of the branch radius.
const SLIM_LOW_MERGE_RADIUS: f64 = 0.5;

/// How close two nodes must be to merge. Orca merges only within one layer's move. Here slim branches
/// below 5 mm also merge within half a branch radius, so they meet in fewer trunks on the bed: half a radius
/// keeps each merged branch standing on the trunk below, and it saved 2 to 17 percent of support on the table,
/// mushroom and toadstool with the share of support resting on nothing unchanged.
fn merge_reach(nodes: &mut Nodes, id: usize, p: &Params) -> f64 {
    let mv = nodes.max_move(id, p);
    if p.slim && nodes.all[id].print_z < SLIM_LOW_MERGE_Z {
        mv.max(SLIM_LOW_MERGE_RADIUS * nodes.radius(id, p))
    } else {
        mv
    }
}

fn drop_nodes(inp: &TreeIn<'_>, p: &Params, vol: &mut Volumes, nodes: &mut Nodes, heights: &[LayerH]) {
    let n = nodes.layers.len();
    if n < 2 {
        return;
    }
    let layer_h = inp.thickness.first().copied().unwrap_or(0.2);
    let wall_count = inp.cfg.tree_settings.wall_count.max(1);
    let angle = inp.cfg.tree_settings.branch_angle.to_radians();
    let max_move_distance = if angle < std::f64::consts::FRAC_PI_2 {
        p.tan_angle * layer_h * f64::from(wall_count)
    } else {
        f64::MAX
    };
    let still_below = if p.slim { 0.0 } else { 5.0 };
    let mut unsupported: Vec<usize> = Vec::new();
    for layer in (1..n).rev() {
        if nodes.layers[layer].is_empty() {
            continue;
        }
        let next = layer - 1;
        let print_z_next = heights[next].z;
        let height_next = heights[next].h;
        let obj = heights[layer].obj.min(vol.outlines.len() - 1);
        let obj_next = heights[next].obj.min(vol.outlines.len() - 1);
        let contours = vol.outlines[obj].clone();
        let parts = vol.outlines_below[obj].clone();
        // Group the nodes per part they stand on (part 0: those going to the bed).
        let mut groups: Vec<BTreeMap<Pt, usize>> = vec![BTreeMap::new(); 1 + parts.len()];
        let layer_nodes = nodes.layers[layer].clone();
        for &id in &layer_nodes {
            let nd = &nodes.all[id];
            if p.on_bed_only && !nd.to_bed {
                unsupported.push(id);
                continue;
            }
            if nd.to_bed || parts.is_empty() {
                groups[0].insert(nd.pos, id);
                continue;
            }
            let mut best = (f64::MAX, 0);
            for (k, part) in parts.iter().enumerate() {
                let ps = one(part);
                if inside(&ps, nd.pos) {
                    best = (0.0, k);
                    break;
                }
                let d = distance_to(&vec![vec![part[0].clone()]], nd.pos);
                if d < best.0 {
                    best = (d, k);
                }
            }
            groups[best.1 + 1].insert(nd.pos, id);
        }
        for (gi, group) in groups.iter().enumerate() {
            let pts: Vec<Pt> = group.keys().copied().collect();
            let mst = spanning_tree(&pts);
            let adj = |q: Pt| mst.get(&q).cloned().unwrap_or_default();
            // First pass: merge nodes that are close together.
            for (&pos, &id) in group {
                if !nodes.all[id].valid {
                    continue;
                }
                let neigh = adj(pos);
                if nodes.all[id].kind == NodeType::Polygon {
                    for q in &neigh {
                        let nid = group[q];
                        if !nodes.all[nid].valid || nodes.all[nid].kind == NodeType::Polygon {
                            continue;
                        }
                        let r = (nodes.all[nid].radius * SCALE) as i64;
                        let ov = nodes.all[id].overhang.clone();
                        let all_in = [(0, 0), (0, r), (0, -r), (-r, 0), (r, 0)]
                            .iter()
                            .all(|d| inside(&ov, add(*q, *d)));
                        if all_in {
                            let (dt, rb, dm) = (
                                nodes.all[nid].distance_to_top,
                                nodes.all[nid].roof_below,
                                nodes.all[nid].dist_mm,
                            );
                            let nd = &mut nodes.all[id];
                            nd.distance_to_top = nd.distance_to_top.max(dt);
                            nd.roof_below = nd.roof_below.max(rb);
                            nd.dist_mm = nd.dist_mm.max(dm);
                            let extra = nodes.all[nid].merged.clone();
                            nodes.all[id].merged.insert(0, nid);
                            nodes.all[id].merged.extend(extra);
                            nodes.all[nid].valid = false;
                        }
                    }
                } else if neigh.len() == 1
                    && d2_mm(sub(neigh[0], pos)) < merge_reach(nodes, id, p).m_powi(2)
                    && adj(neigh[0]).len() == 1
                    && nodes.all[group[&neigh[0]]].kind != NodeType::Polygon
                {
                    let nid = group[&neigh[0]];
                    let mut next_pos = (i64::midpoint(pos.0, neigh[0].0), i64::midpoint(pos.1, neigh[0].1));
                    let next_r = p.calc_radius(nodes.all[id].dist_mm + height_next);
                    if gi == 0 {
                        let avoid = vol.avoidance(next_r, obj_next);
                        let mm = max_move_distance + RESOLUTION_MM + EPS;
                        move_out(&avoid, &mut next_pos, RESOLUTION_MM + EPS, mm);
                    }
                    let (a, b) = (&nodes.all[id], &nodes.all[nid]);
                    let parent = if a.parent.is_some() && b.parent.is_some() {
                        if a.dist_mm >= b.dist_mm { id } else { nid }
                    } else if a.parent.is_some() {
                        id
                    } else {
                        nid
                    };
                    let other = if parent == id { nid } else { id };
                    nodes.all[parent].merged.insert(0, other);
                    let col = vol.collision(0.0, obj_next);
                    let to_bed = !inside(&col, next_pos);
                    let par = nodes.all[parent].clone();
                    let nn = nodes.create(
                        next_pos,
                        par.distance_to_top + 1,
                        obj_next,
                        par.roof_below - i32::from(par.distance_to_top > 0),
                        to_bed,
                        Some(parent),
                        print_z_next,
                        height_next,
                        0.0,
                        0.0,
                        p.diameter_scale,
                    );
                    nodes.max_move(nn, p);
                    nodes.layers[next].push(nn);
                    nodes.all[nid].valid = false;
                    nodes.all[id].valid = false;
                } else if neigh.len() > 1 {
                    for q in &neigh {
                        let lim = merge_reach(nodes, id, p).m_powi(2);
                        if d2_mm(sub(*q, pos)) < lim {
                            let nid = group[q];
                            if nodes.all[nid].kind == NodeType::Polygon
                                || nodes.all[id].dist_mm < nodes.all[nid].dist_mm
                            {
                                continue;
                            }
                            if nodes.all[id].valid {
                                let extra = nodes.all[nid].merged.clone();
                                nodes.all[id].merged.insert(0, nid);
                                nodes.all[id].merged.extend(extra);
                                nodes.all[nid].valid = false;
                            }
                        }
                    }
                }
            }
            // Second pass: move the nodes left.
            for (&pos, &id) in group {
                if !nodes.all[id].valid {
                    continue;
                }
                if nodes.all[id].kind == NodeType::Polygon {
                    let col = vol.collision(0.0, obj_next);
                    let rest = perimeters::difference(&nodes.all[id].overhang, &col);
                    for part in &rest {
                        let ps = one(part);
                        let c = centroid(&ps);
                        let par = nodes.all[id].clone();
                        let nn = nodes.create(
                            c,
                            par.distance_to_top + 1,
                            obj_next,
                            par.roof_below - i32::from(par.distance_to_top > 0),
                            true,
                            Some(id),
                            print_z_next,
                            height_next,
                            0.0,
                            0.0,
                            p.diameter_scale,
                        );
                        nodes.all[nn].max_move = 0.0;
                        nodes.all[nn].overhang = ps;
                        nodes.layers[next].push(nn);
                    }
                    continue;
                }
                if gi > 0 {
                    let col0 = vol.collision(0.0, obj);
                    if inside(&col0, pos) {
                        let r = nodes.radius(id, p);
                        let out = projection_onto(&col0, pos);
                        if d2_mm(sub(pos, out)) >= r * r {
                            if p.on_bed_only {
                                unsupported.push(id);
                            } else {
                                nodes.all[id].valid = false;
                            }
                            continue;
                        }
                        if let Some(par) = nodes.all[id].parent
                            && cut_by(&contours, pos, nodes.all[par].pos)
                        {
                            nodes.all[id].valid = false;
                            continue;
                        }
                    }
                }
                let neigh = adj(pos);
                let mut toward = (0_i64, 0_i64);
                let first_d2 = neigh.first().map_or(0.0, |q| d2_mm(sub(*q, pos)));
                let mm2 = nodes.max_move(id, p).m_powi(2);
                if nodes.all[id].print_z > still_below
                    && (neigh.len() > 1 || (neigh.len() == 1 && first_d2 >= mm2))
                {
                    let mut sum = (0.0_f64, 0.0_f64);
                    for q in &neigh {
                        let nid = group[q];
                        if !nodes.all[nid].valid {
                            continue;
                        }
                        let dir = sub(*q, pos);
                        let d2 = d2_mm(dir);
                        let br = p.calc_radius(nodes.all[id].dist_mm + nodes.all[id].print_z);
                        let nr = p.calc_radius(nodes.all[nid].dist_mm + nodes.all[nid].print_z);
                        let conv = p.tan_angle * (nodes.all[id].print_z - still_below) + br.max(nr);
                        if d2 > conv * conv {
                            continue;
                        }
                        if cut_by(&contours, pos, *q) {
                            continue;
                        }
                        if p.strong {
                            sum = (sum.0 + dir.0 as f64, sum.1 + dir.1 as f64);
                        } else if d2 > 0.0 {
                            // Orca scales the integer direction by 1 / d², in mm², then rounds it to a point.
                            sum = (
                                sum.0 + (dir.0 as f64 / d2).trunc(),
                                sum.1 + (dir.1 as f64 / d2).trunc(),
                            );
                        }
                    }
                    toward = (sum.0.round() as i64, sum.1.round() as i64);
                }
                let next_r = p.calc_radius(nodes.all[id].dist_mm + height_next);
                let avoid_next = vol.avoidance(next_r, obj_next);
                let to_out = projection_onto(&avoid_next, pos);
                let mut dir_out = sub(to_out, pos);
                let mut d2_out = d2_mm(dir_out);
                if cut_by(&contours, pos, to_out)
                    || d2_out > max_move_distance.m_powi(2) * (obj as f64).m_powi(2)
                    || !inside(&avoid_next, pos)
                {
                    let mut cand = pos;
                    let mm = max_move_distance + RESOLUTION_MM + EPS;
                    let col = vol.collision(next_r, obj_next);
                    if move_out(&col, &mut cand, mm, mm) {
                        dir_out = sub(cand, pos);
                        d2_out = d2_mm(dir_out);
                    } else {
                        dir_out = (0, 0);
                        d2_out = 0.0;
                    }
                }
                let mm_units = nodes.max_move(id, p) * SCALE;
                let movement = if nodes.all[id].sharp_tail && nodes.all[id].dist_mm < 3.0 {
                    normal(nodes.all[id].skin, mm_units)
                } else if d2_out > 0.0 {
                    normal(dir_out, mm_units)
                } else {
                    normal(toward, mm_units)
                };
                let next_pos = add(pos, movement);
                let to_bed = !inside(&vol.outlines[obj_next], next_pos);
                let par = nodes.all[id].clone();
                let nn = nodes.create(
                    next_pos,
                    par.distance_to_top + 1,
                    obj_next,
                    par.roof_below - i32::from(par.distance_to_top > 0),
                    to_bed,
                    Some(id),
                    print_z_next,
                    height_next,
                    0.0,
                    0.0,
                    p.diameter_scale,
                );
                // Do not widen a node the part would cut into.
                let col0 = vol.collision(0.0, obj_next);
                let out = projection_onto(&col0, next_pos);
                let dist_out = (d2_mm(sub(out, pos))).sqrt();
                let r = nodes.all[nn].radius;
                nodes.all[nn].radius = par.radius.max(r.min(dist_out));
                nodes.max_move(nn, p);
                nodes.layers[next].push(nn);
            }
        }
        // Branches that cannot reach the bed or the part are pruned.
        let mut queue: Vec<usize> = std::mem::take(&mut unsupported);
        while let Some(leaf) = queue.pop() {
            let mut cur = Some(leaf);
            while let Some(i) = cur {
                if nodes.all[i].is_processed {
                    break;
                }
                let (par, ch, parents) = (
                    nodes.all[i].parent,
                    nodes.all[i].child,
                    nodes.all[i].parents.clone(),
                );
                if let Some(pp) = par {
                    nodes.all[pp].child = ch;
                }
                for pp in &parents {
                    if nodes.all[*pp].child == Some(i) {
                        nodes.all[*pp].child = ch;
                    }
                }
                if let Some(c) = ch {
                    nodes.all[c].parent = par;
                    nodes.all[c].parents.retain(|x| *x != i);
                    nodes.all[c].parents.extend(parents);
                }
                nodes.all[i].is_processed = true;
                for m in nodes.all[i].merged.clone() {
                    if !nodes.all[m].is_processed {
                        queue.insert(0, m);
                    }
                }
                cur = par;
            }
        }
        for l in &mut nodes.layers {
            l.retain(|id| !nodes.all[*id].is_processed);
        }
    }
}

fn centroid(s: &Shapes) -> Pt {
    let (mut ax, mut ay, mut a) = (0.0, 0.0, 0.0);
    if let Some(r) = s.first().and_then(|sh| sh.first()) {
        let n = r.len();
        for i in 0..n {
            let (p, q) = (r[i], r[(i + 1) % n]);
            let cr = f64::from(p.x) * f64::from(q.y) - f64::from(q.x) * f64::from(p.y);
            a += cr;
            ax += (f64::from(p.x) + f64::from(q.x)) * cr;
            ay += (f64::from(p.y) + f64::from(q.y)) * cr;
        }
    }
    if a.abs() < 1e-9 {
        return bbox_of(s).map_or((0, 0), |b| (i64::midpoint(b[0], b[2]), i64::midpoint(b[1], b[3])));
    }
    ((ax / (3.0 * a)).round() as i64, (ay / (3.0 * a)).round() as i64)
}

/// Orca's `TreeSupport::smooth_nodes`: each branch is averaged with its neighbors along it.
fn smooth_nodes(inp: &TreeIn<'_>, nodes: &mut Nodes) {
    for l in &nodes.layers {
        for &i in l {
            nodes.all[i].is_processed = false;
        }
    }
    let max_move = (inp.support_width / 2.0 * SCALE) as i64;
    let layers = nodes.layers.clone();
    for l in &layers {
        for &start in l {
            if nodes.all[start].is_processed {
                continue;
            }
            let mut pts: Vec<Pt> = Vec::new();
            let mut radii: Vec<f64> = Vec::new();
            let mut branch: Vec<usize> = Vec::new();
            let mut total = 0.0;
            if let Some(c) = nodes.all[start].child
                && nodes.all[c].kind != NodeType::Polygon
            {
                pts.push(nodes.all[c].pos);
                radii.push(nodes.all[c].radius);
                branch.push(c);
                total += nodes.all[c].height;
            }
            let mut cur = Some(start);
            while let Some(i) = cur {
                pts.push(nodes.all[i].pos);
                radii.push(nodes.all[i].radius);
                branch.push(i);
                total += nodes.all[i].height;
                cur = nodes.all[i].parent.filter(|pp| !nodes.all[*pp].is_processed);
            }
            if pts.len() < 3 {
                continue;
            }
            let mut pts1 = pts.clone();
            let mut radii1 = radii.clone();
            let iterations = 100;
            for k in 0..iterations {
                for i in 1..pts.len() - 1 {
                    let q = (
                        (pts[i - 1].0 + pts[i].0 + pts[i + 1].0) / 3,
                        (pts[i - 1].1 + pts[i].1 + pts[i + 1].1) / 3,
                    );
                    pts1[i] = q;
                    radii1[i] = (radii[i - 1] + radii[i] + radii[i + 1]) / 3.0;
                    if k == iterations - 1 {
                        let b = branch[i];
                        let mv = (
                            (pts[i + 1].0 - pts[i - 1].0) / 2,
                            (pts[i + 1].1 - pts[i - 1].1) / 2,
                        );
                        let nd = &mut nodes.all[b];
                        nd.pos = q;
                        nd.radius = radii1[i];
                        nd.movement = mv;
                        nd.is_processed = true;
                        if nd.parents.len() > 1
                            || mv.0 > max_move
                            || mv.1 > max_move
                            || (total > 100.0 && nd.dist_mm < 30.0)
                        {
                            nd.extra_wall = true;
                        }
                    }
                }
                if k < iterations - 1 {
                    std::mem::swap(&mut pts, &mut pts1);
                    std::mem::swap(&mut radii, &mut radii1);
                } else {
                    for i in 1..branch.len() - 1 {
                        if nodes.all[branch[i - 1]].extra_wall && nodes.all[branch[i + 1]].extra_wall {
                            nodes.all[branch[i]].extra_wall = true;
                        }
                    }
                }
            }
        }
    }
}

/// One support area to print, and how.
#[derive(Debug, Clone, Default)]
pub(crate) struct TreeArea {
    pub(crate) shape: Shapes,
    /// Base areas printed with walls and infill (the normal-support part of hybrid trees).
    pub(crate) infill: bool,
    /// Base areas that get a second wall.
    pub(crate) extra_wall: bool,
}

/// The support of one layer, by kind (Orca's `area_groups`).
#[derive(Debug, Clone, Default)]
pub(crate) struct TreeLayer {
    pub(crate) base: Vec<TreeArea>,
    pub(crate) roof: Shapes,
    pub(crate) roof_first: Shapes,
    pub(crate) floor: Shapes,
}

/// Orca's `TreeSupport::draw_circles` for every layer.
#[allow(clippy::too_many_lines, reason = "one pass, in Orca's order")]
fn draw(
    inp: &TreeIn<'_>,
    p: &Params,
    vol: &Volumes,
    nodes: &Nodes,
    oh: &Overhangs,
    heights: &[LayerH],
) -> Vec<TreeLayer> {
    let n = nodes.layers.len();
    let n_obj = inp.models.len();
    let t = &inp.cfg.tree_settings;
    let branch_r = (t.branch_diameter / 2.0).max(1e-3);
    let total: usize = nodes.layers.iter().map(Vec::len).sum();
    let nonempty = nodes.layers.iter().filter(|l| !l.is_empty()).count().max(1);
    let square = total / nonempty > 200;
    let res = if square { 4 } else { 100 };
    let circle: Vec<(f64, f64)> = (0..res)
        .map(|i| {
            let a = f64::from(i) / f64::from(res) * std::f64::consts::TAU
                + if square { std::f64::consts::FRAC_PI_4 } else { 0.0 };
            (a.m_cos() * branch_r * SCALE, a.m_sin() * branch_r * SCALE)
        })
        .collect();
    let w_line = u(inp.support_width);
    let bed = {
        let b = inp.bed;
        let q = |x: f64, y: f64| IntPoint::new(u(x), u(y));
        vec![vec![vec![
            q(b[0], b[1]),
            q(b[2], b[1]),
            q(b[2], b[3]),
            q(b[0], b[3]),
        ]]]
    };
    let bottom_layers = inp.cfg.interface_bottom_layers as usize;
    let bottom_gap = inp.cfg.bottom_z_distance;
    let layer_h = inp.thickness.first().copied().unwrap_or(0.2);
    let tops_surf: Vec<Shapes> = (0..n_obj)
        .map(|i| {
            let above = inp.models.get(i + 1).cloned().unwrap_or_default();
            let mut s = perimeters::difference(&inp.models[i], &above);
            if i > 0 {
                s = perimeters::union_all(&[&s, &perimeters::difference(&inp.models[i], &inp.models[i - 1])]);
            } else {
                s = perimeters::union_all(&[&s, &inp.models[0]]);
            }
            s
        })
        .collect();
    let tail_shapes: Vec<Shapes> = oh
        .sharp_tails
        .iter()
        .map(|l| l.iter().map(|(s, _)| s.clone()).collect())
        .collect();
    let mut out: Vec<TreeLayer> = vec![TreeLayer::default(); n];
    for layer in 0..n {
        let ids = &nodes.layers[layer];
        if ids.is_empty() {
            continue;
        }
        let obj = heights[layer].obj.min(n_obj - 1);
        let height = heights[layer].h;
        if height < EPS {
            continue;
        }
        let collision = |sharp: bool| -> Shapes {
            let off = if sharp {
                p.top_z
            } else if obj == 0 {
                inp.first_layer_gap
            } else {
                p.xy
            };
            let mut c = perimeters::offset(&vol.outlines[obj], u(off));
            if p.top_z > EPS {
                let mut acc = 0.0;
                for l in obj + 1..vol.outlines.len() {
                    acc += inp.thickness[l];
                    if acc > p.top_z {
                        break;
                    }
                    c = perimeters::union_all(&[&c, &perimeters::offset(&vol.outlines[l], u(p.top_z))]);
                }
            }
            c
        };
        let col_base = collision(false);
        let col_tail = collision(true);
        let (mut base, mut roof, mut roof1, mut gap): (Vec<Shapes>, Vec<Shapes>, Vec<Shapes>, Vec<Shapes>) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut area_poly: Shapes = Vec::new();
        let mut extra_wall = false;
        for &id in ids {
            let nd = &nodes.all[id];
            let top_iface_h = p.top_layers as f64 * nd.height;
            let col = if nd.sharp_tail && nd.distance_to_top <= 0 {
                &col_tail
            } else {
                &col_base
            };
            let mut area: Shapes;
            if nd.kind == NodeType::Polygon || (nd.distance_to_top < 0 && !nd.sharp_tail) {
                let big = nd
                    .overhang
                    .iter()
                    .filter_map(|s| s.first())
                    .any(|r| r.len() > 100)
                    || nd.overhang.iter().any(|s| s.len() > 2);
                area = if big {
                    nd.overhang.clone()
                } else {
                    perimeters::offset(&nd.overhang, u(p.xy))
                };
                area = perimeters::difference(&area, col);
                if nd.kind == NodeType::Polygon {
                    area_poly = perimeters::union_all(&[&area_poly, &area]);
                }
            } else {
                let scale = nd.radius / branch_r;
                let mx = nd.movement.0 as f64 / (scale * branch_r * SCALE);
                let my = nd.movement.1 as f64 / (scale * branch_r * SCALE);
                let ring: Vec<IntPoint<i32>> = if !square && mx.abs() > 0.001 && my.abs() > 0.001 {
                    let vinv = 0.5 / (0.01 + mx.m_hypot(my));
                    let m = [
                        scale * (1.0 + mx * mx * vinv),
                        scale * (mx * my * vinv),
                        scale * (mx * my * vinv),
                        scale * (1.0 + my * my * vinv),
                    ];
                    circle
                        .iter()
                        .map(|&(x, y)| {
                            IntPoint::new(
                                (nd.pos.0 as f64 + m[0] * x + m[1] * y).round() as i32,
                                (nd.pos.1 as f64 + m[2] * x + m[3] * y).round() as i32,
                            )
                        })
                        .collect()
                } else {
                    circle
                        .iter()
                        .map(|&(x, y)| {
                            IntPoint::new(
                                (nd.pos.0 as f64 + x * scale).round() as i32,
                                (nd.pos.1 as f64 + y * scale).round() as i32,
                            )
                        })
                        .collect()
                };
                let mut shape: Shapes = vec![vec![ring]];
                if obj == 0 {
                    let brim = if t.auto_brim {
                        MIN_BRANCH_RADIUS_FIRST_LAYER.max(
                            (nd.radius + nd.dist_mm / (scale * branch_r) * 0.5)
                                .min(MAX_BRANCH_RADIUS_FIRST_LAYER)
                                - nd.radius,
                        )
                    } else {
                        t.brim_width
                    };
                    let grown = perimeters::offset(&shape, u(brim));
                    if let Some(first) = grown.first() {
                        shape = vec![vec![first[0].clone()]];
                    }
                }
                area = largest_piece(&shape, col);
                if nd.extra_wall {
                    extra_wall = true;
                }
                if p.top_layers > 0 && nd.roof_below > 0 && !p.on_bed_only && !nd.sharp_tail {
                    let big = nd
                        .overhang
                        .iter()
                        .filter_map(|s| s.first())
                        .any(|r| r.len() > 100)
                        || nd.overhang.iter().any(|s| s.len() > 2);
                    let ov = if big {
                        nd.overhang.clone()
                    } else {
                        perimeters::offset(&nd.overhang, u(p.xy))
                    };
                    area = perimeters::union_all(&[&area, &ov]);
                }
            }
            if obj > 0 && nd.distance_to_top < 0 {
                gap.push(area);
            } else if obj > 0
                && nd.roof_below == 1
                && (nd.dist_mm - p.top_z) < top_iface_h + EPS
                && !nd.sharp_tail
            {
                roof1.push(area);
            } else if obj > 0
                && nd.roof_below > 1
                && (nd.dist_mm - p.top_z) < top_iface_h + EPS
                && !nd.sharp_tail
            {
                roof.push(area);
            } else {
                base.push(area);
            }
        }
        let un = |v: &Vec<Shapes>| -> Shapes {
            let refs: Vec<&Shapes> = v.iter().collect();
            perimeters::union_all(&refs)
        };
        let close = |s: &Shapes| perimeters::offset(&perimeters::offset(s, w_line), -w_line);
        let roof_s = perimeters::intersection(&perimeters::difference(&close(&un(&roof)), &col_base), &bed);
        let mut roof1_s = perimeters::difference(&close(&un(&roof1)), &col_base);
        roof1_s = perimeters::intersection(&perimeters::difference(&roof1_s, &roof_s), &bed);
        let roofs = perimeters::union_all(&[&roof1_s, &roof_s, &un(&gap)]);
        let mut base_s = perimeters::intersection(&perimeters::difference(&un(&base), &roofs), &bed);
        // Floors and the bottom gap where a branch comes down on the part.
        let mut floor_s: Shapes = Vec::new();
        if !base_s.is_empty() && !p.on_bed_only && (bottom_gap > EPS || bottom_layers > 0) {
            let iface_h = bottom_layers as f64 * layer_h;
            let top_z = heights[layer].z;
            let bottom_z = top_z - height;
            let mut new_base: Shapes = Vec::new();
            for comp in &base_s {
                let mut c = one(comp);
                let mut bands: Vec<(f64, Shapes)> = Vec::new();
                for idx in (0..=obj).rev() {
                    let s = &tops_surf[idx];
                    if s.is_empty() || !overlaps(&c, s) {
                        continue;
                    }
                    bands.push((inp.tops[idx], s.clone()));
                }
                if bands.is_empty() {
                    new_base.extend(c);
                    continue;
                }
                crate::sorting::sort_by(&mut bands, |a, b| a.0.total_cmp(&b.0));
                let mut cleared = false;
                for (z, surf) in &bands {
                    if top_z < z - EPS {
                        continue;
                    }
                    let gap_top = z + bottom_gap;
                    if bottom_gap > EPS && bottom_z < gap_top - EPS {
                        cleared = true;
                        c = perimeters::difference(&c, surf);
                    }
                    if bottom_layers > 0 && bottom_z >= gap_top - EPS && bottom_z < gap_top + iface_h - EPS {
                        let band =
                            perimeters::intersection(surf, &perimeters::offset(&c, u(inp.support_width)));
                        let iface = if band.is_empty() {
                            Vec::new()
                        } else {
                            perimeters::intersection(&c, &band)
                        };
                        if !iface.is_empty() {
                            floor_s = perimeters::union_all(&[&floor_s, &iface]);
                            c = perimeters::difference(&c, &perimeters::offset(&iface, 1));
                        }
                    }
                }
                if cleared && c.is_empty() {
                    continue;
                }
                new_base.extend(c);
            }
            base_s = new_base;
        }
        // Hybrid trees widen the normal-support part of the first layer like normal supports.
        if layer == 0 && p.hybrid && inp.raft_first_layer_expansion > 0.0 {
            let trim = perimeters::offset(&inp.models[0], u(inp.first_layer_gap));
            let steps = ((inp.raft_first_layer_expansion / inp.support_width).ceil() as i32).max(5);
            let step = u(inp.raft_first_layer_expansion / f64::from(steps));
            let mut grown: Shapes = Vec::new();
            for comp in &base_s {
                let mut e = one(comp);
                if overlaps(&e, &area_poly) {
                    for _ in 0..steps {
                        e = perimeters::difference(&perimeters::offset(&e, step), &trim);
                    }
                }
                grown.extend(e);
            }
            base_s = perimeters::union_all(&[&grown]);
        }
        // Clear of the part in the layers it overlaps and those within the bottom gap below it.
        if !base_s.is_empty() {
            let trim = trim_regions(
                inp,
                heights[layer].z,
                heights[layer].h,
                0.0,
                bottom_gap,
                0.0,
                &tail_shapes,
            );
            if !trim.is_empty() {
                base_s = perimeters::difference(&base_s, &trim);
            }
        }
        let drop_small_holes = |s: Shapes| -> Shapes {
            s.into_iter()
                .map(|mut sh| {
                    let mut kept = vec![sh.remove(0)];
                    kept.extend(sh.into_iter().filter(|h| {
                        let (lo_x, hi_x) = h
                            .iter()
                            .fold((i32::MAX, i32::MIN), |(a, b), p| (a.min(p.x), b.max(p.x)));
                        let (lo_y, hi_y) = h
                            .iter()
                            .fold((i32::MAX, i32::MIN), |(a, b), p| (a.min(p.y), b.max(p.y)));
                        let (w, d) = if h.is_empty() {
                            (0, 0)
                        } else {
                            (hi_x - lo_x, hi_y - lo_y)
                        };
                        !(f64::from(w) < 2.0 * SCALE && f64::from(d) < 2.0 * SCALE)
                    }));
                    kept
                })
                .collect()
        };
        let base_s = drop_small_holes(base_s);
        out[layer] = TreeLayer {
            base: base_s
                .into_iter()
                .map(|sh| {
                    let s = vec![sh];
                    let infill = overlaps(&s, &area_poly);
                    TreeArea {
                        infill,
                        extra_wall: extra_wall && !infill,
                        shape: s,
                    }
                })
                .collect(),
            roof: drop_small_holes(roof_s),
            roof_first: drop_small_holes(roof1_s),
            floor: drop_small_holes(floor_s),
        };
    }
    out
}

/// Orca's `TreeSupport::get_trim_support_regions` for support layer `layer` on the object's layers.
fn trim_regions(
    inp: &TreeIn<'_>,
    top: f64,
    height: f64,
    gap_above: f64,
    gap_below: f64,
    gap_xy: f64,
    tails: &[Shapes],
) -> Shapes {
    let bottom = top - height;
    let mut out: Vec<Shapes> = Vec::new();
    let z0 = bottom - gap_below + EPS;
    for (i, m) in inp.models.iter().enumerate() {
        let (kt, kh) = (inp.tops[i], inp.thickness[i]);
        if kt < z0 {
            continue;
        }
        if kt - kh > top + gap_above - EPS {
            break;
        }
        let overlap =
            (top - kt).abs() < EPS || (top < kt && top > kt - kh) || (top > kt && bottom < kt - EPS);
        for part in m {
            let ps = one(part);
            let tail = tails.get(i).is_some_and(|t| overlaps(&ps, t));
            let off = if tail {
                0.2
            } else if overlap {
                gap_xy
            } else {
                0.2
            };
            out.push(perimeters::offset(&ps, u(off)));
        }
    }
    let refs: Vec<&Shapes> = out.iter().collect();
    perimeters::union_all(&refs)
}

/// Slim, strong and hybrid tree supports for the object layers of `inp` (one support layer per object layer).
pub(crate) fn plan(inp: &TreeIn<'_>) -> Vec<(LayerH, TreeLayer)> {
    let cfg = inp.cfg;
    let t = &cfg.tree_settings;
    let n = inp.models.len();
    let style = cfg.style;
    let mut top_z = cfg.top_z_distance;
    if top_z > EPS {
        top_z = top_z.max(inp.min_layer_height);
    }
    let p = Params {
        base_radius: MIN_BRANCH_RADIUS.max(t.branch_diameter / 2.0),
        diameter_scale: t
            .branch_diameter_angle
            .to_radians()
            .clamp(0.0, std::f64::consts::FRAC_PI_2 - EPS),
        tan_angle: t.branch_angle.to_radians().m_tan(),
        support_width: inp.support_width,
        slim: style == SupportStyle::TreeSlim,
        strong: style == SupportStyle::TreeStrong,
        hybrid: style == SupportStyle::TreeHybrid,
        top_z,
        top_layers: cfg.interface_top_layers as usize,
        xy: cfg.xy_distance,
        on_bed_only: cfg.on_build_plate_only,
    };
    let oh = detect_overhangs(inp);
    let mut nodes = Nodes {
        all: Vec::new(),
        layers: vec![Vec::new(); n],
    };
    contact_points(inp, &oh, &p, &mut nodes);
    let heights = plan_heights(inp, &p, &mut nodes);
    let mut vol = Volumes::new(inp.models, inp.thickness, t.branch_angle, cfg.xy_distance);
    drop_nodes(inp, &p, &mut vol, &mut nodes, &heights);
    smooth_nodes(inp, &mut nodes);
    let _ = &oh.extrudable;
    let layers = draw(inp, &p, &vol, &nodes, &oh, &heights);
    heights.into_iter().zip(layers).collect()
}

/// Orca's `TreeSupport::plan_layer_heights`: the support layers, and the contact nodes moved onto them.
/// With `independent_support_layer_height` the layers between contacts are as few as the maximum support layer
/// height allows, all the same thickness; otherwise they are the object's layers.
fn plan_heights(inp: &TreeIn<'_>, p: &Params, nodes: &mut Nodes) -> Vec<LayerH> {
    let n = inp.models.len();
    let mut heights: Vec<LayerH> = Vec::new();
    if inp.independent {
        // Every height keyed by its top in tenths of a micrometer, so equal tops merge as in Orca's map.
        let key = |z: f64| (z * 1e7).round() as i64;
        let mut bounds: BTreeMap<i64, (f64, f64)> = BTreeMap::new();
        let mut z_heights: BTreeMap<i64, (f64, f64)> = BTreeMap::new();
        let (z0, h0) = (inp.tops[0], inp.thickness[0]);
        bounds.insert(key(z0), (z0, h0));
        z_heights.insert(key(z0), (z0, h0));
        for l in 1..nodes.layers.len() {
            if let Some(&f) = nodes.layers[l].first() {
                let (z, h) = (nodes.all[f].print_z, nodes.all[f].height);
                bounds.entry(key(z)).or_insert((z, h));
                let b = (z - h).max(z0);
                bounds.entry(key(b)).or_insert((b, 0.0));
            }
        }
        let list: Vec<(f64, f64)> = bounds.values().copied().collect();
        let mut i1 = 0;
        for i2 in 1..list.len() {
            let (z1, _) = list[i1];
            let (z2, _) = list[i2];
            let dist = z2 - z1;
            if dist < inp.min_layer_height - EPS {
                continue;
            }
            let k = (dist / inp.max_layer_height).ceil().max(1.0) as usize;
            let step = dist / k as f64;
            let mut z = z1 + step;
            for _ in 0..k {
                z_heights.insert(key(z), (z, step));
                z += step;
            }
            i1 = i2;
        }
        let mut obj = 0;
        for &(z, h) in z_heights.values() {
            while obj < n && inp.tops[obj] < z - h / 2.0 {
                obj += 1;
            }
            heights.push(LayerH {
                z,
                h,
                obj: obj.min(n - 1),
            });
        }
    } else {
        heights = (0..n)
            .map(|i| LayerH {
                z: inp.tops[i],
                h: inp.thickness[i],
                obj: i,
            })
            .collect();
    }
    // The contact nodes go to the support layer nearest their height.
    let mut layers: Vec<Vec<usize>> = vec![Vec::new(); heights.len()];
    for l in std::mem::take(&mut nodes.layers) {
        let Some(&f) = l.first() else { continue };
        let z = nodes.all[f].print_z;
        let best = (0..heights.len())
            .min_by(|&a, &b| (heights[a].z - z).abs().total_cmp(&(heights[b].z - z).abs()))
            .unwrap_or(0);
        layers[best].extend(l);
    }
    // A gap thicker than one support layer takes several of them.
    for (ln, l) in layers.iter().enumerate() {
        let Some(&f) = l.first() else { continue };
        let new_h = heights[ln].h;
        let h = nodes.all[f].height;
        if (h - new_h).abs() < EPS || (p.top_z < EPS && h < EPS) {
            continue;
        }
        let (mut acc, mut num) = (0.0, 0);
        for i in (0..=ln).rev() {
            if heights[i].h > EPS {
                acc += heights[i].h;
                num += 1;
                if acc > h - EPS {
                    break;
                }
            }
        }
        for &id in l {
            nodes.all[id].height = new_h;
            nodes.all[id].distance_to_top = -num;
        }
    }
    if inp.independent && p.top_layers > 0 {
        let iface_h = p.top_layers as f64 * inp.thickness.get(1).copied().unwrap_or(inp.thickness[0]);
        for l in &layers {
            for &id in l {
                let nd = &mut nodes.all[id];
                if nd.height <= EPS {
                    continue;
                }
                let remaining = iface_h - (nd.dist_mm - p.top_z);
                let fit = if remaining < -EPS {
                    0
                } else {
                    ((remaining + EPS) / nd.height).floor() as i32
                };
                nd.roof_below = fit.min(p.top_layers as i32);
            }
        }
    }
    nodes.layers = layers;
    heights
}
