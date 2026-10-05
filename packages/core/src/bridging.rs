// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Internal bridges over sparse infill (Orca's `PrintObject::bridge_over_infill`): the first solid layer
//! over sparse infill is printed as bridge strands, running across the gap between the lines that hold
//! them, so the strands are anchored on both sides.
//!
//! Per layer: the internal solid areas that sit over unsupported infill are the candidates; each is grown
//! over the sparse infill below (as deep as a thick bridge reaches), a bridging direction is chosen from the
//! sparse infill lines that anchor it, and strands are extended to the nearest anchor line. The sparse infill
//! under a bridge is taken out, and a ring of solid infill is kept under the bridge edge where it meets
//! the walls (`additional_ensuring`).

use crate::fm::Fm as _;
use crate::geom::mm;
use crate::perimeters::{self, Shapes};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::i_float::int::point::IntPoint;
use i_overlay::string::clip::{ClipRule, IntClip};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

type Line = [IntPoint<i32>; 2];

/// What the bridging rule reads about one layer: its infill area and how it is divided, and the
/// lines of its sparse infill (which anchor the bridges above).
#[derive(Debug, Default, Clone)]
pub(crate) struct Facts {
    pub(crate) inner: Shapes,
    pub(crate) top: Shapes,
    /// The bottom surfaces with the bridges over air.
    pub(crate) bottom: Shapes,
    pub(crate) shell: Shapes,
    pub(crate) sparse: Shapes,
    /// The sparse infill of a pattern laid on scanlines, as segments.
    pub(crate) lines: Vec<Line>,
    /// The sparse infill paths of the other patterns, as the layer prints them over `sparse`.
    pub(crate) paths: Vec<Vec<crate::geom::Point>>,
    /// The layer's own bridges over air (`classify`), for the extra bridge layer above them.
    pub(crate) external: Vec<Bridged>,
    /// The bottom surfaces alone. With the fields above it is the layer's whole classification.
    pub(crate) own_bottom: Shapes,
}

impl Facts {
    /// The sparse infill as segments.
    fn segments(&self) -> Vec<Line> {
        let as_int = |p: crate::geom::Point| IntPoint::new(p.x, p.y);
        let mut out = self.lines.clone();
        out.extend(
            self.paths
                .iter()
                .flat_map(|p| p.windows(2))
                .filter_map(|s| Some([as_int(*s.first()?), as_int(*s.get(1)?)])),
        );
        out
    }

    /// The classification the facts were worked out from.
    pub(crate) fn classes(&self) -> crate::classify::Classes {
        crate::classify::Classes {
            top: self.top.clone(),
            bottom: self.own_bottom.clone(),
            shell: self.shell.clone(),
            sparse: self.sparse.clone(),
            bridges: self.external.clone(),
        }
    }
}

/// Settings and lookups for one object's bridges.
pub(crate) struct Env<'a> {
    /// Results shared with the layers around, and the fingerprint of the settings they were worked out with.
    pub(crate) cache: Option<(&'a crate::shells::Cache, u64)>,
    pub(crate) facts: &'a dyn Fn(i64) -> Option<Arc<Facts>>,
    pub(crate) print_z: &'a dyn Fn(i64) -> f64,
    pub(crate) count: i64,
    /// Solid infill line spacing, mm.
    pub(crate) solid_spacing: f64,
    /// Bridging flow spacing, width and height, mm.
    pub(crate) bridge_spacing: f64,
    pub(crate) bridge_width: f64,
    pub(crate) bridge_height: f64,
    /// Sparse infill at 100 percent: nothing is sparse.
    pub(crate) sparse_full: bool,
    /// 3 by default, 1 when small internal bridges are kept (`dont_filter_internal_bridges`).
    pub(crate) multiplier: f64,
    /// `dont_filter_internal_bridges` = `nofilter`: every unsupported piece grown by four spacings is a
    /// candidate, however small and however much of its surface is supported.
    pub(crate) nofilter: bool,
    /// Added to the bridging angle for patterns whose lines are not the anchors' direction (radians).
    pub(crate) angle_bias: f64,
    /// `internal_bridge_angle` in degrees when set, and whether it is relative to the chosen one.
    pub(crate) custom_angle: Option<(f64, bool)>,
}

/// The expanded bridging area of one candidate and its strand direction (radians).
#[derive(Debug, Clone)]
pub(crate) struct Bridged {
    pub(crate) area: Shapes,
    pub(crate) angle: f64,
}

/// Results kept while one layer's bridges are worked out.
#[derive(Default)]
pub(crate) struct MemoData {
    bridged: HashMap<i64, Arc<Vec<Bridged>>>,
    cands: HashMap<i64, Arc<Vec<Shapes>>>,
}

pub(crate) type Memo = RefCell<MemoData>;

/// Area in mm2.
fn area(s: &Shapes) -> f64 {
    crate::shells::area_mm2(s)
}

fn sub(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        a.clone()
    } else {
        perimeters::difference(a, b)
    }
}

fn meet(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        Vec::new()
    } else {
        perimeters::intersection(a, b)
    }
}

fn union(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() {
        b.clone()
    } else if b.is_empty() {
        a.clone()
    } else {
        perimeters::union_all(&[a, b])
    }
}

fn shrink(s: &Shapes, d: f64) -> Shapes {
    if s.is_empty() {
        Vec::new()
    } else {
        perimeters::offset(s, -mm(d))
    }
}

fn expand(s: &Shapes, d: f64) -> Shapes {
    if s.is_empty() {
        Vec::new()
    } else {
        perimeters::offset(s, mm(d))
    }
}

fn closing(s: &Shapes, d: f64) -> Shapes {
    if s.is_empty() {
        Vec::new()
    } else {
        shrink(&expand(s, d), d)
    }
}

fn opening(s: &Shapes, d: f64) -> Shapes {
    if s.is_empty() {
        return Vec::new();
    }
    let e = shrink(s, d);
    if e.is_empty() { Vec::new() } else { expand(&e, d) }
}

/// Segments of every ring of `s`.
fn outline_lines(s: &Shapes) -> Vec<Line> {
    let mut out = Vec::new();
    for ring in s.iter().flat_map(|sh| sh.iter()) {
        let n = ring.len();
        for i in 0..n {
            if let (Some(&a), Some(&b)) = (ring.get(i), ring.get((i + 1) % n)) {
                out.push([a, b]);
            }
        }
    }
    out
}

/// Bounding box `[min_x, min_y, max_x, max_y]` of shapes.
fn extents(s: &Shapes) -> Option<[i32; 4]> {
    perimeters::bounds(s)
}

/// The sparse infill of a layer by the rules of `bridge_over_infill`: a bridge is over sparse infill when
/// the layer below has it, outside the solid areas there.
fn candidates(env: &Env<'_>, l: i64) -> Vec<Shapes> {
    let (Some(here), Some(below)) = ((env.facts)(l), if l > 0 { (env.facts)(l - 1) } else { None }) else {
        return Vec::new();
    };
    if here.shell.is_empty() {
        return Vec::new();
    }
    let sp = env.solid_spacing;
    let mult = env.multiplier;
    let mut lower_solids = if env.sparse_full {
        below.inner.clone()
    } else {
        union(&union(&below.top, &below.bottom), &below.shell)
    };
    // Thin parts that support nothing go, then the rest grows by the filter distance.
    lower_solids = shrink(&lower_solids, sp);
    lower_solids = expand(&lower_solids, (1.0 + mult) * sp);
    let mut unsupported = closing(&below.inner, 0.01);
    unsupported = shrink(&unsupported, mult * sp);
    unsupported = sub(&unsupported, &lower_solids);
    let mut out = Vec::new();
    for piece in &here.shell {
        let one: Shapes = vec![piece.clone()];
        let un = meet(&one, &unsupported);
        if un.is_empty() {
            continue;
        }
        if env.nofilter {
            out.push(expand(&un, 4.0 * sp));
            continue;
        }
        let partially = area(&un) < area(&one) - 1e-6;
        if partially && area(&un) <= 9.0 * sp * sp {
            continue;
        }
        let mut worth = meet(&one, &expand(&un, 4.0 * sp));
        // The leftovers: small ones are merged back so the surface is not broken up.
        let rest = sub(&one, &expand(&worth, sp));
        for p in rest {
            let q: Shapes = vec![p];
            let a = area(&q);
            if a < sp * 12.0 && a > sp * sp {
                worth = union(&worth, &q);
            }
        }
        worth = meet(&closing(&worth, 0.01), &one);
        if !worth.is_empty() {
            out.push(worth);
        }
    }
    out
}

/// Candidates in Orca's order: by the corner of their extents, then by distance from the first one's
/// far corner.
fn sorted_candidates(mut c: Vec<Shapes>) -> Vec<Shapes> {
    let key = |s: &Shapes| extents(s).map_or((0, 0), |b| (b[0], b[1]));
    crate::sorting::sort_by_key(&mut c, key);
    if c.len() > 2 {
        let origin = c
            .first()
            .and_then(extents)
            .map_or((0.0, 0.0), |b| (f64::from(b[2]), f64::from(b[3])));
        let d2 = |s: &Shapes| {
            let (x, y) = key(s);
            (origin.0 - f64::from(x)).m_powi(2) + (origin.1 - f64::from(y)).m_powi(2)
        };
        if let Some((_, rest)) = c.split_first_mut() {
            crate::sorting::sort_by(rest, |a, b| d2(a).total_cmp(&d2(b)));
        }
    }
    c
}

fn rotate_point(p: IntPoint<i32>, cos: f64, sin: f64) -> (i64, i64) {
    let (x, y) = (f64::from(p.x), f64::from(p.y));
    #[allow(clippy::cast_possible_truncation, reason = "a rotated plate coordinate")]
    (
        (cos * x - sin * y).round() as i64,
        (cos * y + sin * x).round() as i64,
    )
}

/// The direction the strands over `area` take: the most common direction across the anchor lines nearest to
/// its outline, turned a right angle (Orca's `determine_bridging_angle`).
fn determine_angle(outline: &Shapes, anchors: &[Line], bias: f64) -> f64 {
    let pi = std::f64::consts::PI;
    let mut counted: BTreeMap<i64, (f64, i32)> = BTreeMap::new();
    let step = f64::from(mm(2.0));
    for ring in outline.iter().flat_map(|s| s.iter()) {
        let mut acc = 0.0;
        for w in ring.windows(2) {
            let (Some(&a), Some(&b)) = (w.first(), w.get(1)) else {
                continue;
            };
            let (start, next) = ((f64::from(a.x), f64::from(a.y)), (f64::from(b.x), f64::from(b.y)));
            let v = (next.0 - start.0, next.1 - start.1);
            let dist = v.0.m_hypot(v.1);
            acc += dist;
            if acc > step && dist > 0.0 {
                acc = 0.0;
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a small count"
                )]
                let count = (dist / step).ceil() as usize;
                let size = dist / count as f64;
                let u = (v.0 / dist, v.1 / dist);
                for i in 0..count {
                    let p = (start.0 + u.0 * i as f64 * size, start.1 + u.1 * i as f64 * size);
                    let Some(line) = nearest_line(anchors, p) else {
                        continue;
                    };
                    let d = (f64::from(line[1].x - line[0].x), f64::from(line[1].y - line[0].y));
                    let mut angle = d.1.m_atan2(d.0);
                    if angle < 0.0 {
                        angle += 2.0 * pi;
                    }
                    if angle > pi {
                        angle -= pi;
                    }
                    angle += pi * 0.5;
                    #[allow(clippy::cast_possible_truncation, reason = "a key for equal angles")]
                    let key = (angle * 1e12).round() as i64;
                    let e = counted.entry(key).or_insert((angle, 0));
                    e.1 += 1;
                }
            }
        }
    }
    let entries: Vec<(f64, i32)> = counted.values().copied().collect();
    let mut best = (0.0_f64, 0_i32);
    for &(dir, _) in &entries {
        let (mut score, mut acc) = (0_i32, 0.0_f64);
        let (lo, hi) = (dir - pi * 0.1, dir + pi * 0.1);
        for &(a, c) in &entries {
            if a >= lo && a <= hi {
                acc += a * f64::from(c);
                score += c;
            }
        }
        // The span of directions is 0.5 pi to 1.5 pi; the edges also take the opposite direction.
        if lo < 0.5 * pi {
            let from = 1.5 * pi - (0.5 * pi - lo);
            for &(a, c) in &entries {
                if a >= from {
                    acc += (a - pi) * f64::from(c);
                    score += c;
                }
            }
        }
        if lo > 1.5 * pi {
            for &(a, c) in &entries {
                if a <= lo - 1.5 * pi {
                    acc += (a + pi) * f64::from(c);
                    score += c;
                }
            }
        }
        if score > best.1 {
            best = (acc / f64::from(score), score);
        }
    }
    let mut angle = best.0;
    if angle == 0.0 {
        angle = 0.001;
    }
    angle + bias
}

fn nearest_line(lines: &[Line], p: (f64, f64)) -> Option<Line> {
    let mut best: Option<(f64, Line)> = None;
    for l in lines {
        let (a, b) = (
            (f64::from(l[0].x), f64::from(l[0].y)),
            (f64::from(l[1].x), f64::from(l[1].y)),
        );
        let d = (b.0 - a.0, b.1 - a.1);
        let len2 = d.0 * d.0 + d.1 * d.1;
        let t = if len2 > 0.0 {
            (((p.0 - a.0) * d.0 + (p.1 - a.1) * d.1) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let q = (a.0 + d.0 * t, a.1 + d.1 * t);
        let dist2 = (p.0 - q.0).m_powi(2) + (p.1 - q.1).m_powi(2);
        if best.as_ref().is_none_or(|(b, _)| dist2 < *b) {
            best = Some((dist2, *l));
        }
    }
    best.map(|(_, l)| l)
}

/// Crossings of the vertical line `x` with `lines`, sorted by y.
fn crossings(lines: &[[(i64, i64); 2]], x: i64) -> Vec<i64> {
    let mut ys: Vec<i64> = Vec::new();
    for l in lines {
        let (a, b) = (l[0], l[1]);
        let (lo, hi) = if a.0 <= b.0 { (a, b) } else { (b, a) };
        if lo.0 <= x && x < hi.0 {
            #[allow(clippy::cast_precision_loss, reason = "coordinates stay far below 2^52")]
            let f = (x - lo.0) as f64 / (hi.0 - lo.0) as f64;
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_precision_loss,
                reason = "a coordinate between two points"
            )]
            ys.push(lo.1 + ((hi.1 - lo.1) as f64 * f).round() as i64);
        }
    }
    ys.sort_unstable();
    ys
}

/// Strands over `area` extended to the nearest anchor line on each side, as a polygon (Orca's
/// `construct_anchored_polygon`).
fn anchored_polygon(region: &Shapes, anchors: &[Line], sp: i64, width: i64, angle: f64) -> Shapes {
    let aligning = -angle + std::f64::consts::FRAC_PI_2;
    let (cos, sin) = (aligning.m_cos(), aligning.m_sin());
    let rot = |p: IntPoint<i32>| rotate_point(p, cos, sin);
    let area_lines: Vec<[(i64, i64); 2]> = outline_lines(region)
        .iter()
        .map(|l| [rot(l[0]), rot(l[1])])
        .collect();
    let anchor_lines: Vec<[(i64, i64); 2]> = anchors.iter().map(|l| [rot(l[0]), rot(l[1])]).collect();
    let pts_x = area_lines.iter().flat_map(|l| l.iter()).map(|p| p.0);
    let (Some(x_min), Some(x_max)) = (pts_x.clone().min(), pts_x.max()) else {
        return Vec::new();
    };
    let pts_y = anchor_lines.iter().flat_map(|l| l.iter()).map(|p| p.1);
    let (Some(y_min), Some(y_max)) = (pts_y.clone().min(), pts_y.max()) else {
        return Vec::new();
    };
    let sp = sp.max(1);
    let n_vlines = usize::try_from((x_max - x_min + sp - 1) / sp).unwrap_or(0);
    let _ = (y_min, y_max);
    // Sections of the area along each vertical line, reaching to the anchors.
    let mut sections: Vec<(i64, Vec<(i64, i64)>)> = Vec::with_capacity(n_vlines);
    for i in 0..n_vlines {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_precision_loss,
            reason = "a coordinate"
        )]
        let x = x_min + ((i as f64 + 0.5) * sp as f64) as i64;
        let ys = crossings(&area_lines, x);
        let anchor_ys = crossings(&anchor_lines, x);
        let mut secs: Vec<(i64, i64)> = ys.as_chunks::<2>().0.iter().map(|c| (c[0], c[1])).collect();
        for s in &mut secs {
            // The nearest anchor crossing below the section's start, and above its end.
            if let Some(&below) = anchor_ys.iter().rev().find(|&&y| y < s.0) {
                s.0 = below - width;
            }
            if let Some(&above) = anchor_ys.iter().find(|&&y| y > s.1) {
                s.1 = above + width;
            }
        }
        // Overlapping sections on one line become one.
        for k in 0..secs.len().saturating_sub(1) {
            let (a, b) = (secs.get(k).copied(), secs.get(k + 1).copied());
            if let (Some(a), Some(b)) = (a, b) {
                let overlap = (a.0 >= b.0 && a.0 <= b.1)
                    || (a.1 >= b.0 && a.1 <= b.1)
                    || (b.0 >= a.0 && b.0 <= a.1)
                    || (b.1 >= a.0 && b.1 <= a.1);
                if overlap {
                    let merged = (a.0.min(b.0), a.1.max(b.1));
                    if let Some(s) = secs.get_mut(k + 1) {
                        *s = merged;
                    }
                    if let Some(s) = secs.get_mut(k) {
                        *s = (a.1, a.1);
                    }
                }
            }
        }
        secs.retain(|s| s.0 != s.1);
        crate::sorting::sort_by_key(&mut secs, |s| s.0);
        sections.push((x, secs));
    }
    // Polygons from the sections of neighboring lines.
    let half = sp / 2;
    #[allow(clippy::cast_precision_loss, reason = "coordinates stay far below 2^52")]
    let limit2 = 36.0 * (sp as f64) * (sp as f64);
    #[allow(clippy::cast_precision_loss, reason = "coordinates stay far below 2^52")]
    let d2 = |a: P, b: P| ((a.0 - b.0) as f64).m_powi(2) + ((a.1 - b.1) as f64).m_powi(2);
    let mut out: Vec<Vec<P>> = Vec::new();
    let mut current: Vec<Traced> = Vec::new();
    for (x, secs) in &sections {
        let segs: Vec<(P, P)> = secs.iter().map(|&(a, b)| ((*x, a), (*x, b))).collect();
        let mut used = vec![false; segs.len()];
        for tr in &mut current {
            let (Some(&low), Some(&high)) = (tr.lows.last(), tr.highs.last()) else {
                continue;
            };
            let begin = segs.partition_point(|s| s.1.1 <= low.1);
            let end = segs.partition_point(|s| s.0.1 <= high.1);
            let mut added = false;
            let mut c = begin;
            while c < end && !added {
                if used.get(c).copied().unwrap_or(true) {
                    c += 1;
                    continue;
                }
                let Some(&(a, b)) = segs.get(c) else { break };
                if d2(low, a) < limit2 {
                    tr.lows.push(a);
                } else {
                    tr.lows.push((low.0 + half, low.1));
                    tr.lows.push((a.0 - half, a.1));
                    tr.lows.push(a);
                }
                if d2(high, b) < limit2 {
                    tr.highs.push(b);
                } else {
                    tr.highs.push((high.0 + half, high.1));
                    tr.highs.push((b.0 - half, b.1));
                    tr.highs.push(b);
                }
                added = true;
                if let Some(u) = used.get_mut(c) {
                    *u = true;
                }
            }
            if !added {
                tr.lows.push((low.0 + half, low.1));
                tr.highs.push((high.0 + half, high.1));
                let mut poly = std::mem::take(&mut tr.lows);
                poly.extend(std::mem::take(&mut tr.highs).into_iter().rev());
                out.push(poly);
            }
        }
        current.retain(|t| !t.lows.is_empty());
        for (k, &(a, b)) in segs.iter().enumerate() {
            if !used.get(k).copied().unwrap_or(true) {
                current.push(Traced {
                    lows: vec![(a.0 - half, a.1), a],
                    highs: vec![(b.0 - half, b.1), b],
                });
            }
        }
    }
    for tr in current {
        let mut poly = tr.lows;
        poly.extend(tr.highs.into_iter().rev());
        out.push(poly);
    }
    // Back to the plate frame.
    let (bc, bs) = ((-aligning).m_cos(), (-aligning).m_sin());
    let shapes: Shapes = out
        .into_iter()
        .filter(|p| p.len() >= 3)
        .map(|p| {
            let ring: Vec<IntPoint<i32>> = p
                .iter()
                .map(|&(x, y)| {
                    let (fx, fy) = (x as f64, y as f64);
                    #[allow(clippy::cast_possible_truncation, reason = "a plate coordinate")]
                    IntPoint::new(
                        (bc * fx - bs * fy).round() as i32,
                        (bc * fy + bs * fx).round() as i32,
                    )
                })
                .collect();
            vec![ring]
        })
        .collect();
    if shapes.is_empty() {
        shapes
    } else {
        perimeters::union_all(&[&shapes])
    }
}

/// Clips open lines to shapes.
fn clip_lines(lines: &[Line], shapes: &Shapes) -> Vec<Line> {
    if lines.is_empty() || shapes.is_empty() {
        return Vec::new();
    }
    let paths: Vec<Vec<IntPoint<i32>>> = lines.iter().map(|l| vec![l[0], l[1]]).collect();
    let clipped = shapes.clip_paths(
        &paths,
        FillRule::NonZero,
        ClipRule {
            invert: false,
            boundary_included: true,
        },
    );
    let mut out = Vec::new();
    for p in clipped {
        for w in p.windows(2) {
            if let (Some(&a), Some(&b)) = (w.first(), w.get(1)) {
                out.push([a, b]);
            }
        }
    }
    out
}

fn union_rects(s: &[Shapes], by: f64) -> Vec<[i32; 4]> {
    s.iter()
        .filter_map(extents)
        .map(|b| {
            let d = mm(by);
            [b[0] - d, b[1] - d, b[2] + d, b[3] + d]
        })
        .collect()
}

fn rects_overlap(a: &[[i32; 4]], b: &[[i32; 4]]) -> bool {
    a.iter().any(|p| {
        b.iter()
            .any(|q| p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3])
    })
}

/// The bridging areas of layer `l`, one per candidate, each with its direction.
pub(crate) fn bridge_layer(env: &Env<'_>, l: i64, memo: &Memo) -> Arc<Vec<Bridged>> {
    if let Some(r) = memo.borrow().bridged.get(&l) {
        return Arc::clone(r);
    }
    let result = match env.cache {
        Some((c, tag)) => c.bridged(l, tag, || compute(env, l, memo)),
        None => Arc::new(compute(env, l, memo)),
    };
    memo.borrow_mut().bridged.insert(l, Arc::clone(&result));
    result
}

fn cands_of(env: &Env<'_>, l: i64, memo: &Memo) -> Arc<Vec<Shapes>> {
    if let Some(r) = memo.borrow().cands.get(&l) {
        return Arc::clone(r);
    }
    let result = match env.cache {
        Some((c, tag)) => c.cands(l, tag, || candidates(env, l)),
        None => Arc::new(candidates(env, l)),
    };
    memo.borrow_mut().cands.insert(l, Arc::clone(&result));
    result
}

/// The nearest layer below `cur` that has candidates, when it is within one bridge height.
fn previous_with_candidates(env: &Env<'_>, cur: i64, memo: &Memo) -> Option<i64> {
    let z = (env.print_z)(cur);
    let h = env.bridge_height * 0.9;
    let mut j = cur - 1;
    while j >= 1 && (env.print_z)(j) >= z - h - 1e-4 {
        if !cands_of(env, j, memo).is_empty() {
            return Some(j);
        }
        j -= 1;
    }
    None
}

fn compute(env: &Env<'_>, l: i64, memo: &Memo) -> Vec<Bridged> {
    if l < 1 || l >= env.count {
        return Vec::new();
    }
    let cands = sorted_candidates((*cands_of(env, l, memo)).clone());
    if cands.is_empty() {
        return Vec::new();
    }
    let Some(here) = (env.facts)(l) else {
        return Vec::new();
    };
    let sp = env.bridge_spacing;
    let target_h = env.bridge_height * 0.9;
    let z = (env.print_z)(l);
    // Sparse infill deep enough for a thick bridge, where strands can go.
    let deep = {
        let bottom_z = z - target_h - 1e-4;
        let mut sparse: Shapes = Vec::new();
        let mut other: Shapes = Vec::new();
        let mut i = l - 1;
        while i >= 0 {
            if (env.print_z)(i) < bottom_z && i < l - 1 {
                break;
            }
            if let Some(f) = (env.facts)(i) {
                if env.sparse_full {
                    other = union(&other, &f.inner);
                } else {
                    sparse = union(&sparse, &f.sparse);
                    other = union(&other, &sub(&f.inner, &f.sparse));
                }
            }
            i -= 1;
        }
        sparse = closing(&sparse, 0.01);
        other = closing(&other, 0.01);
        sub(&sparse, &other)
    };
    // Areas the layers below in the same bridge cluster already bridged.
    let mut filled: Shapes = Vec::new();
    {
        let mut cur = l;
        let cand_rects = union_rects(&cands, 7.0);
        let mut cur_rects = cand_rects;
        while let Some(p) = previous_with_candidates(env, cur, memo) {
            let pz = (env.print_z)(p);
            let cz = (env.print_z)(cur);
            let p_rects = union_rects(&cands_of(env, p, memo), 7.0);
            if pz < cz - env.bridge_height * 0.9 - 1e-4 || !rects_overlap(&p_rects, &cur_rects) {
                break;
            }
            if pz >= z - target_h - 1e-4 {
                for b in bridge_layer(env, p, memo).iter() {
                    filled = union(&filled, &b.area);
                }
            } else {
                break;
            }
            cur = p;
            cur_rects = p_rects;
        }
    }
    let deep = expand(&sub(&deep, &filled), sp * 1.5);
    // Where sparse and solid infill of this layer are, to cut anchors from.
    let total_fill = closing(&here.inner, 0.01);
    let mut expansion = closing(&union(&here.sparse, &here.shell), 0.01);
    expansion = meet(&expansion, &deep);
    let below_lines = (env.facts)(l - 1).map(|f| f.segments()).unwrap_or_default();
    let anchors = clip_lines(&below_lines, &shrink(&expansion, sp));
    let internal_unsupported = shrink(&deep, sp * 4.5);
    let mut done: Vec<Bridged> = Vec::new();
    for cand in &cands {
        let mut to_bridge = meet(&expand(cand, sp), &deep);
        to_bridge.retain(|p| {
            let one: Shapes = vec![p.clone()];
            !meet(&one, &internal_unsupported).is_empty()
        });
        if to_bridge.is_empty() {
            continue;
        }
        let limiting = union(&to_bridge, &expansion);
        // Boundary lines: the fill area's outline and the limiting area's outline.
        let mut boundary: Vec<Line> = outline_lines(&expand(&total_fill, 1.3 * sp));
        boundary.extend(outline_lines(&expand(&limiting, 0.3 * env.bridge_spacing)));
        let outline: Shapes = to_bridge.clone();
        let mut angle = if anchors.is_empty() {
            determine_angle(&outline, &boundary, 0.0)
        } else {
            determine_angle(&outline, &anchors, env.angle_bias)
        };
        if let Some((deg, relative)) = env.custom_angle.filter(|(d, _)| *d > 0.0) {
            let rad = deg.to_radians();
            angle = if relative { angle + rad } else { rad };
        }
        boundary.extend(anchors.iter().copied());
        let (units, width) = (i64::from(mm(sp)), i64::from(mm(env.bridge_width)));
        let mut bridging = anchored_polygon(&to_bridge, &boundary, units, width, angle);
        // A neighbor bridged on this layer keeps its direction when the two meet.
        let grown = expand(&bridging, 3.0 * sp);
        if let Some(other) = done.iter().find(|d| !meet(&d.area, &grown).is_empty()) {
            angle = other.angle;
            bridging = anchored_polygon(&to_bridge, &boundary, units, width, angle);
        }
        bridging = opening(&bridging, sp * 0.75);
        bridging = closing(&bridging, sp);
        bridging = meet(&bridging, &limiting);
        bridging = meet(&bridging, &total_fill);
        bridging = sub(&bridging, &here.top);
        expansion = sub(&expansion, &bridging);
        if !bridging.is_empty() {
            done.push(Bridged {
                area: bridging,
                angle,
            });
        }
    }
    done
}

/// The solid ring kept under the edges of the bridges of layer `l + 1`, inside the band along the walls of
/// layer `l` (`additional_ensuring`).
pub(crate) fn ensuring(env: &Env<'_>, l: i64, memo: &Memo) -> Shapes {
    let above = bridge_layer(env, l + 1, memo);
    if above.is_empty() {
        return Vec::new();
    }
    let Some(here) = (env.facts)(l) else {
        return Vec::new();
    };
    let mut ring: Shapes = Vec::new();
    for b in above.iter() {
        let edge = sub(&b.area, &shrink(&b.area, env.solid_spacing));
        ring = union(&ring, &edge);
    }
    let near = {
        let fill = closing(&here.inner, 0.01);
        sub(&fill, &shrink(&fill, env.solid_spacing))
    };
    meet(&ring, &near)
}

/// Monotonic strands over `area` along `angle` (radians), at `spacing` mm, joined along the wall
/// (`FillMonotonic` with no limit on the links): Orca's `fill_surface_by_lines` for a bridge surface.
/// `reference` is the plate point the lines are aligned to (the object's center).
pub(crate) fn fill(
    area: &Shapes,
    angle: f64,
    spacing_mm: f64,
    reference: (i32, i32),
) -> Vec<Vec<crate::geom::Point>> {
    if area.is_empty() {
        return Vec::new();
    }
    // The lines are vertical in a frame turned by `angle + pi / 2`.
    let phi = angle + std::f64::consts::FRAC_PI_2;
    let (c, s) = (phi.m_cos(), phi.m_sin());
    let rot = |p: IntPoint<i32>| -> (i64, i64) {
        let (x, y) = (f64::from(p.x), f64::from(p.y));
        #[allow(clippy::cast_possible_truncation, reason = "a rotated plate coordinate")]
        ((x * c + y * s).round() as i64, (-x * s + y * c).round() as i64)
    };
    let back = |x: i64, y: i64| -> crate::geom::Point {
        let (fx, fy) = (x as f64, y as f64);
        #[allow(clippy::cast_possible_truncation, reason = "a plate coordinate")]
        crate::geom::Point::new((fx * c - fy * s).round() as i32, (fx * s + fy * c).round() as i32)
    };
    let spacing = i64::from(mm(spacing_mm)).max(1);
    let (ref_x, _) = rot(IntPoint::new(reference.0, reference.1));
    // Lines sit half a spacing (and a hair) off the grid through the reference, as for full infill.
    let origin = ref_x + i64::midpoint(spacing, 100);
    let sp_in = spacing_mm;
    let outer = perimeters::offset(area, -mm(0.05 * sp_in));
    let inner = perimeters::offset(area, -mm(0.5 * sp_in));
    if inner.is_empty() || outer.is_empty() {
        return Vec::new();
    }
    let scan = |shapes: &Shapes| -> crate::infill::Spans {
        let rings: Vec<Vec<(i64, i64)>> = shapes
            .iter()
            .flat_map(|sh| sh.iter())
            .map(|r| r.iter().map(|&p| rot(p)).collect())
            .collect();
        let mut events: Vec<(i32, i64)> = Vec::new();
        for ring in &rings {
            let n = ring.len();
            for i in 0..n {
                let (Some(&a), Some(&b)) = (ring.get(i), ring.get((i + 1) % n)) else {
                    continue;
                };
                if a.0 == b.0 {
                    continue;
                }
                let (lo, hi) = if a.0 < b.0 { (a, b) } else { (b, a) };
                let ceil_div = |v: i64| {
                    let q = (v - origin).div_euclid(spacing);
                    if q * spacing == v - origin { q } else { q + 1 }
                };
                for k in ceil_div(lo.0)..ceil_div(hi.0) {
                    let x = origin + k * spacing;
                    let t = lo.1 + (x - lo.0) * (hi.1 - lo.1) / (hi.0 - lo.0);
                    #[allow(clippy::cast_possible_truncation, reason = "a scanline index on a bed")]
                    events.push((k as i32, t));
                }
            }
        }
        events.sort_unstable();
        let mut out: crate::infill::Spans = Vec::new();
        let mut i = 0;
        while let (Some(&(ka, ta)), Some(&(kb, tb))) = (events.get(i), events.get(i + 1)) {
            if ka != kb {
                i += 1;
                continue;
            }
            match out.last_mut() {
                Some(l) if l.k == ka && ta <= l.t1 => l.t1 = l.t1.max(tb),
                _ if tb > ta => out.push(crate::infill::Iv {
                    k: ka,
                    t0: ta,
                    t1: tb,
                }),
                _ => {}
            }
            i += 2;
        }
        out
    };
    let spans_in = scan(&inner);
    let spans_out = scan(&outer);
    if spans_in.is_empty() {
        return Vec::new();
    }
    let edge = {
        let mut e = crate::edge::Edge::new(&inner);
        let to = |k: i32, t: i64| back(origin + i64::from(k) * spacing, t);
        e.mark_ends(spans_in.iter().flat_map(|iv| [to(iv.k, iv.t0), to(iv.k, iv.t1)]));
        e
    };
    let links = crate::monotonic::Links {
        edge: Some(&edge),
        max: f64::MAX,
        chord_fallback: false,
    };
    crate::monotonic::polylines_outer(&spans_in, &spans_out, spacing, links, &|off, t| {
        back(origin + off, t)
    })
}

type P = (i64, i64);

struct Traced {
    lows: Vec<P>,
    highs: Vec<P>,
}

/// What the bridging rule decides for one layer.
#[derive(Debug, Clone)]
pub(crate) struct LayerBridges {
    pub(crate) areas: Vec<Bridged>,
    /// A second bridge layer over the bridges over air of the layer below (`enable_extra_bridge_layer`).
    pub(crate) extra_external: Vec<Bridged>,
    pub(crate) ensure: Shapes,
    /// Strand spacing, mm, and the plate point the strands are aligned to.
    pub(crate) spacing: f64,
    pub(crate) reference: (i32, i32),
    /// Strands are round with diameter `width`, else normal beads.
    pub(crate) thick: bool,
    pub(crate) width: f64,
    /// The layer's own facts, worked out for its whole outline with the layer's settings.
    pub(crate) own: Option<Arc<Facts>>,
}

/// One bridge with its grown parts and the zone pieces it reaches.
struct One {
    shape: Shapes,
    grown: Shapes,
    anchors: Shapes,
}

/// What the bottom surface over air of one layer becomes (`process_external_surfaces`): bridges grown into the
/// shell, sparse and top areas beside them so their strands are anchored, with a strand direction each, and
/// the zones they leave.
pub(crate) struct External {
    pub(crate) bridges: Vec<Bridged>,
    pub(crate) shell: Shapes,
    pub(crate) sparse: Shapes,
    pub(crate) top: Shapes,
}

/// The pieces of `zone` that `src`, grown by a tiny amount, touches.
fn touched(src: &Shapes, zone: &Shapes, tiny: f64) -> Shapes {
    if src.is_empty() || zone.is_empty() {
        return Vec::new();
    }
    let seed = perimeters::offset_round(src, mm(tiny));
    zone.iter()
        .filter(|piece| !meet(&seed, &vec![(*piece).clone()]).is_empty())
        .cloned()
        .collect()
}

/// Orca's `BRIDGE_INFILL_MARGIN`, mm.
pub(crate) const BRIDGE_INFILL_MARGIN_MM: f64 = 1.0;

/// [`bridging_direction`] for other modules.
pub(crate) fn direction(bridge: &Shapes, anchors: &Shapes) -> f64 {
    bridging_direction(bridge, anchors)
}

/// The strand direction of a bridge (radians): the direction whose strands cross the fewest floating edges
/// (the parts of its outline no anchor area covers), or across the shorter way of an area anchored all
/// round (`detect_bridging_direction`).
fn bridging_direction(bridge: &Shapes, anchors: &Shapes) -> f64 {
    let pi = std::f64::consts::PI;
    let outline = outline_lines(bridge);
    let floating: Vec<Line> = if anchors.is_empty() {
        outline
    } else {
        let grown = expand(anchors, 0.01);
        let paths: Vec<Vec<IntPoint<i32>>> = outline.iter().map(|l| vec![l[0], l[1]]).collect();
        grown
            .clip_paths(
                &paths,
                FillRule::NonZero,
                ClipRule {
                    invert: true,
                    boundary_included: true,
                },
            )
            .iter()
            .flat_map(|p| p.windows(2).map(|w| [w[0], w[1]]))
            .collect()
    };
    let dir = if floating.is_empty() {
        // Anchored on all sides: across the minor axis of the area.
        minor_axis(bridge)
    } else {
        // The normals of the floating edges, one per direction.
        let mut dirs: Vec<(i64, (f64, f64))> = Vec::new();
        for l in &floating {
            let (dx, dy) = (f64::from(l[1].x - l[0].x), f64::from(l[1].y - l[0].y));
            let len = dx.m_hypot(dy);
            if len == 0.0 {
                continue;
            }
            let n = (dy / len, -dx / len);
            #[allow(clippy::cast_possible_truncation, reason = "a key for equal angles")]
            let key = (n.1.m_atan2(n.0) * 1000.0).ceil() as i64;
            if !dirs.iter().any(|(k, _)| *k == key) {
                dirs.push((key, n));
            }
        }
        let mut best: Option<(f64, (f64, f64))> = None;
        for (_, n) in &dirs {
            let cost: f64 = floating
                .iter()
                .map(|l| {
                    let (dx, dy) = (f64::from(l[1].x - l[0].x), f64::from(l[1].y - l[0].y));
                    (dx * n.0 + dy * n.1).abs()
                })
                .sum();
            if best.is_none_or(|(c, _)| cost < c) {
                best = Some((cost, (n.1, -n.0)));
            }
        }
        best.map_or((1.0, 0.0), |(_, d)| d)
    };
    pi + dir.1.m_atan2(dir.0)
}

/// The direction of the smaller spread of the area (the second principal component), or along x when it has none.
fn minor_axis(s: &Shapes) -> (f64, f64) {
    // Area moments from the outlines (Green's theorem), holes subtracting.
    let (mut a, mut cx, mut cy, mut ixx, mut iyy, mut ixy) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for ring in s.iter().flat_map(|sh| sh.iter()) {
        let n = ring.len();
        for i in 0..n {
            let (Some(p), Some(q)) = (ring.get(i), ring.get((i + 1) % n)) else {
                continue;
            };
            let (x0, y0, x1, y1) = (
                f64::from(p.x) / 1e4,
                f64::from(p.y) / 1e4,
                f64::from(q.x) / 1e4,
                f64::from(q.y) / 1e4,
            );
            let c = x0 * y1 - x1 * y0;
            a += c / 2.0;
            cx += (x0 + x1) * c / 6.0;
            cy += (y0 + y1) * c / 6.0;
            ixx += (x0 * x0 + x0 * x1 + x1 * x1) * c / 12.0;
            iyy += (y0 * y0 + y0 * y1 + y1 * y1) * c / 12.0;
            ixy += (x0 * y1 + 2.0 * x0 * y0 + 2.0 * x1 * y1 + x1 * y0) * c / 24.0;
        }
    }
    if a.abs() < 1e-9 {
        return (1.0, 0.0);
    }
    let (mx, my) = (cx / a, cy / a);
    let (vx, vy, cov) = (ixx / a - mx * mx, iyy / a - my * my, ixy / a - mx * my);
    if cov.abs() < 1e-7 {
        // Axis-aligned: the direction of the smaller variance.
        return if vy > vx { (1.0, 0.0) } else { (0.0, 1.0) };
    }
    let root = ((vx - vy).m_powi(2) + 4.0 * cov * cov).sqrt();
    let (ea, eb) = (0.5 * (vx + vy + root), 0.5 * (vx + vy - root));
    let vec_b = ((if ea > eb { eb } else { ea }) - vy) / cov;
    let n = vec_b.m_hypot(1.0);
    (vec_b / n, 1.0 / n)
}

/// Orca's `expand_bridges_detect_orientations`. `solid` and `sparse` are how far a bridge grows into the
/// shell and top zones and into the sparse zone, mm; `closing` is the radius the merged surface is closed by.
pub(crate) fn external(
    bottom: &Shapes,
    shell: &Shapes,
    sparse: &Shapes,
    top: &Shapes,
    solid: f64,
    sparse_d: f64,
    closing_r: f64,
) -> External {
    let zones = [(shell, solid), (sparse, sparse_d), (top, solid)];
    let mut ones: Vec<One> = Vec::new();
    for piece in bottom {
        let shape: Shapes = vec![piece.clone()];
        let mut grown: Shapes = Vec::new();
        let mut anchors: Shapes = Vec::new();
        for (zone, d) in &zones {
            let pieces = touched(&shape, zone, (0.25 * d).min(0.05));
            if pieces.is_empty() {
                continue;
            }
            let reach = perimeters::offset_round(&shape, mm(*d));
            grown = union(&grown, &meet(&reach, &pieces));
            anchors = union(&anchors, &pieces);
        }
        ones.push(One {
            shape,
            grown,
            anchors,
        });
    }
    // Bridges whose grown parts overlap print as one surface.
    let n = ones.len();
    let mut group: Vec<usize> = (0..n).collect();
    let find = |g: &mut Vec<usize>, mut i: usize| {
        while g.get(i).copied().unwrap_or(i) != i {
            i = g.get(i).copied().unwrap_or(i);
        }
        i
    };
    for i in 0..n {
        for j in i + 1..n {
            let overlap = match (ones.get(i), ones.get(j)) {
                (Some(a), Some(b)) => !meet(&a.grown, &b.grown).is_empty(),
                _ => false,
            };
            if overlap {
                let (gi, gj) = (find(&mut group, i), find(&mut group, j));
                let (lo, hi) = (gi.min(gj), gi.max(gj));
                if let Some(g) = group.get_mut(hi) {
                    *g = lo;
                }
            }
        }
    }
    let mut bridges: Vec<Bridged> = Vec::new();
    let mut gone: Shapes = Vec::new();
    for head in 0..n {
        if find(&mut group, head) != head {
            continue;
        }
        let mut acc: Shapes = Vec::new();
        for k in head..n {
            if find(&mut group, k) == head
                && let Some(o) = ones.get(k)
            {
                acc = union(&union(&acc, &o.shape), &o.grown);
            }
        }
        let Some(h) = ones.get(head) else { continue };
        let angle = bridging_direction(&h.shape, &h.anchors);
        let area = closing(&acc, closing_r);
        gone = union(&gone, &area);
        bridges.push(Bridged { area, angle });
    }
    let cut = |z: &Shapes| sub(z, &gone);
    External {
        bridges,
        shell: cut(shell),
        sparse: cut(sparse),
        top: cut(top),
    }
}

/// `enable_extra_bridge_layer`: which bridges get a second layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExtraLayer {
    pub(crate) external: bool,
    pub(crate) internal: bool,
}

impl ExtraLayer {
    pub(crate) fn of(cfg: &crate::config::PrintConfig) -> Self {
        let v = match cfg.raw.get("enable_extra_bridge_layer") {
            Some(serde_json::Value::String(s)) => s.as_str(),
            _ => "disabled",
        };
        Self {
            external: matches!(v, "external_bridge_only" | "apply_to_all"),
            internal: matches!(v, "internal_bridge_only" | "apply_to_all"),
        }
    }
}

/// The second layer over the internal bridges of the layer below (Orca `bridge_over_infill`, the second
/// internal bridge pass): each bridge of the layer below, opened by the solid infill width `d` (mm), meets
/// this layer's internal area (solid and sparse); what survives an opening by `d` is bridged again, at a
/// right angle to the bridge under it. Orca turns every piece of a layer by the last bridge's angle; each
/// piece here takes the angle of the bridge it sits on.
pub(crate) fn second_internal(env: &Env<'_>, l: i64, memo: &Memo, d: f64, own: &[Bridged]) -> Vec<Bridged> {
    if l < 2 || l >= env.count {
        return Vec::new();
    }
    let below = bridge_layer(env, l - 1, memo);
    let Some(here) = (env.facts)(l) else {
        return Vec::new();
    };
    let internal = union(&here.shell, &here.sparse);
    let taken = own.iter().fold(Shapes::new(), |acc, b| union(&acc, &b.area));
    below
        .iter()
        .filter_map(|b| {
            let base = opening(&b.area, d);
            let mut ov = opening(&meet(&internal, &base), d);
            if !taken.is_empty() {
                ov = sub(&ov, &taken);
            }
            (!ov.is_empty()).then_some(Bridged {
                area: ov,
                angle: b.angle + std::f64::consts::FRAC_PI_2,
            })
        })
        .collect()
}

/// The second layer over the bridges over air of the layer below (Orca `detect_surfaces_type`, the
/// stInternalAfterExternalBridge pass): where such a bridge lies under this layer's internal area, the
/// overlap opened by `band` (the outer wall width plus the other walls, mm) and kept clear of this layer's
/// top surfaces grown by `band` prints as a bridge again, parallel to the one below.
pub(crate) fn second_external(env: &Env<'_>, l: i64, band: f64) -> Vec<Bridged> {
    if l < 1 || l >= env.count {
        return Vec::new();
    }
    let (Some(below), Some(here)) = ((env.facts)(l - 1), (env.facts)(l)) else {
        return Vec::new();
    };
    if below.external.is_empty() {
        return Vec::new();
    }
    let internal = union(&here.shell, &here.sparse);
    let top = expand(&here.top, band);
    below
        .external
        .iter()
        .filter_map(|b| {
            let mut ov = opening(&meet(&internal, &b.area), band);
            if !top.is_empty() {
                ov = sub(&ov, &top);
            }
            (!ov.is_empty()).then_some(Bridged {
                area: ov,
                angle: b.angle,
            })
        })
        .collect()
}
