// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Seam placement for the whole object, as Orca's `SeamPlacer` does it (`GCode/SeamPlacer.cpp`).
//!
//! Every layer's outer wall becomes a ring of candidate points. Each candidate gets the angle of the
//! wall there, its visibility (raycast over the model, `raycast.rs`), how far it hangs over the layer
//! below and how deep it lies inside the layer (hidden between regions). Each ring picks its best point
//! by that score; the aligned modes then link the picks of neighboring layers into strings and fit a
//! cubic B-spline through each string, so the seam climbs the part in a smooth line. A wall ring placed
//! later finds its ring here by the nearest candidate and starts at the seam point.
//!
//! The planner works on the object as a whole, so it is built once per session before the parallel
//! stages, and a shard reads the same seams as a full run.

use crate::config::SeamPosition;
use crate::fm::Fm as _;
use crate::overhang::Support;
use i_overlay::i_float::int::point::IntPoint;

type V2 = [f32; 2];
type V3 = [f32; 3];

/// Orca's constants (`SeamPlacer.hpp`).
const ANGLE_IMPORTANCE_ALIGNED: f32 = 0.6;
const ANGLE_IMPORTANCE_NEAREST: f32 = 1.0;
const OVERHANG_ANGLE_TAN: f32 = 1.0;
const ALIGN_SCORE_TOLERANCE: f32 = 0.3;
const ALIGN_TOLERABLE_DIST_FACTOR: f32 = 4.0;
const ALIGN_MINIMUM_STRING_SEAMS: usize = 6;
const ALIGN_MM_PER_SEGMENT: f32 = 4.0;
const SHARP_ANGLE_SNAPPING: f32 = 55.0 * std::f32::consts::PI / 180.0;

/// One layer's input: the outer wall rings and the whole slice.
pub(crate) struct LayerIn {
    pub z: f32,
    pub height: f32,
    /// Outer wall rings, each with the width of its wall, mm.
    pub rings: Vec<(Vec<IntPoint<i32>>, f32)>,
    pub outline: crate::perimeters::Shapes,
    /// More than one region has walls here, so points inside the union are hidden.
    pub multi: bool,
}

/// A painted seam point: `Blocked` below `Neutral` below `Enforced` (Orca `EnforcedBlockedSeamPoint`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Blocked,
    Neutral,
    Enforced,
}

#[derive(Debug, Clone)]
struct Cand {
    kind: Kind,
    /// The middle of the longest enforced stretch of the ring (or its sharpest corner there).
    central: bool,
    pos: V3,
    perim: u32,
    visibility: f32,
    overhang: f32,
    unsupported: f32,
    embedded: f32,
    angle: f32,
}

#[derive(Debug, Clone)]
struct Perim {
    start: u32,
    end: u32,
    seam: u32,
    width: f32,
    finalized: bool,
    fin: V3,
}

#[derive(Debug, Clone, Default)]
struct LayerSeams {
    pts: Vec<Cand>,
    perims: Vec<Perim>,
    /// The candidates by position, for finding the one nearest a point.
    grid: Option<Grid>,
}

/// Candidate indices binned by a square grid over their bounds, about one candidate per cell.
#[derive(Debug, Clone)]
struct Grid {
    origin: [f64; 2],
    cell: f64,
    nx: usize,
    ny: usize,
    /// Cell `c` holds `idx[start[c]..start[c + 1]]`, in candidate order.
    start: Vec<u32>,
    idx: Vec<u32>,
}

impl Grid {
    fn new(pts: &[Cand]) -> Option<Self> {
        let first = pts.first()?;
        let (mut lo, mut hi) = (
            [f64::from(first.pos[0]), f64::from(first.pos[1])],
            [f64::from(first.pos[0]), f64::from(first.pos[1])],
        );
        for c in pts {
            let (x, y) = (f64::from(c.pos[0]), f64::from(c.pos[1]));
            lo = [lo[0].min(x), lo[1].min(y)];
            hi = [hi[0].max(x), hi[1].max(y)];
        }
        let (w, h) = (hi[0] - lo[0], hi[1] - lo[1]);
        #[allow(clippy::cast_precision_loss, reason = "a candidate count")]
        let cell = (w * h / pts.len() as f64).sqrt().max(w.max(h) / 1024.0).max(1e-3);
        if !cell.is_finite() {
            return None;
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "at most 1025 cells a side"
        )]
        let (nx, ny) = ((w / cell) as usize + 1, (h / cell) as usize + 1);
        let mut g = Self {
            origin: lo,
            cell,
            nx,
            ny,
            start: vec![0; nx * ny + 1],
            idx: vec![0; pts.len()],
        };
        let cells: Vec<usize> = pts.iter().map(|c| g.cell_of([c.pos[0], c.pos[1]])).collect();
        for &c in &cells {
            if let Some(v) = g.start.get_mut(c + 1) {
                *v += 1;
            }
        }
        for c in 1..g.start.len() {
            let prev = g.start.get(c - 1).copied().unwrap_or(0);
            if let Some(v) = g.start.get_mut(c) {
                *v += prev;
            }
        }
        let mut fill = g.start.clone();
        for (i, &c) in cells.iter().enumerate() {
            if let Some(f) = fill.get_mut(c) {
                if let Some(slot) = g.idx.get_mut(*f as usize) {
                    *slot = u32::try_from(i).unwrap_or(u32::MAX);
                }
                *f += 1;
            }
        }
        Some(g)
    }

    /// Column and row of a point, clamped to the grid.
    fn col_row(&self, p: V2) -> (usize, usize) {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "clamped to the grid"
        )]
        let f = |v: f32, o: f64, n: usize| {
            (((f64::from(v) - o) / self.cell).floor().max(0.0) as usize).min(n - 1)
        };
        (f(p[0], self.origin[0], self.nx), f(p[1], self.origin[1], self.ny))
    }

    fn cell_of(&self, p: V2) -> usize {
        let (x, y) = self.col_row(p);
        y * self.nx + x
    }

    /// The indices of the candidates for which `keep` holds among those within `r` of `q` (with a micron
    /// of slack for single-precision rounding), in index order.
    fn within(&self, pts: &[Cand], q: V2, r: f32, keep: impl Fn(&Cand) -> bool) -> Vec<usize> {
        let r = r + 1e-3;
        let (x0, y0) = self.col_row([q[0] - r, q[1] - r]);
        let (x1, y1) = self.col_row([q[0] + r, q[1] + r]);
        let mut out = Vec::new();
        for y in y0..=y1 {
            let (Some(&s), Some(&e)) = (
                self.start.get(y * self.nx + x0),
                self.start.get(y * self.nx + x1 + 1),
            ) else {
                continue;
            };
            out.extend(
                self.idx
                    .get(s as usize..e as usize)
                    .unwrap_or(&[])
                    .iter()
                    .map(|&i| i as usize)
                    .filter(|&i| pts.get(i).is_some_and(&keep)),
            );
        }
        out.sort_unstable();
        out
    }

    /// The index of the candidate nearest `q`, the first one among equally near ones: the answer of a scan
    /// over all of them. Cells are visited in square rings around the cell of `q`; a candidate outside the
    /// rings visited so far is at least the rings' width away, so the search stops once that width passes
    /// the nearest distance found, with a micron of slack for the rounding of single-precision distances.
    fn nearest(&self, pts: &[Cand], q: V2) -> Option<usize> {
        let (cx, cy) = self.col_row(q);
        let mut best: Option<(f32, usize)> = None;
        let visit = |c: usize, best: &mut Option<(f32, usize)>| {
            let (Some(&s), Some(&e)) = (self.start.get(c), self.start.get(c + 1)) else {
                return;
            };
            for &i in self.idx.get(s as usize..e as usize).unwrap_or(&[]) {
                let i = i as usize;
                let Some(a) = pts.get(i) else { continue };
                let d = dist2([a.pos[0], a.pos[1]], q);
                if best.is_none_or(|(bd, bi)| d.total_cmp(&bd).then(i.cmp(&bi)).is_lt()) {
                    *best = Some((d, i));
                }
            }
        };
        for k in 0..self.nx.max(self.ny) {
            let (x0, x1) = (cx.saturating_sub(k), (cx + k).min(self.nx - 1));
            let (y0, y1) = (cy.saturating_sub(k), (cy + k).min(self.ny - 1));
            for y in y0..=y1 {
                if y + k == cy || y == cy + k {
                    for x in x0..=x1 {
                        visit(y * self.nx + x, &mut best);
                    }
                } else {
                    if x0 + k == cx {
                        visit(y * self.nx + x0, &mut best);
                    }
                    if x1 == cx + k {
                        visit(y * self.nx + x1, &mut best);
                    }
                }
            }
            #[allow(clippy::cast_precision_loss, reason = "a ring count")]
            let reach = k as f64 * self.cell;
            if let Some((d, _)) = best
                && reach > f64::from(d).sqrt() + 1e-3
            {
                break;
            }
        }
        best.map(|(_, i)| i)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Plan {
    mode: SeamPosition,
    layers: Vec<LayerSeams>,
    /// `staggered_inner_seams`: the inner wall's width, mm, when the inner seams zigzag backwards.
    pub(crate) stagger: Option<f64>,
}

/// Where a wall ring starts.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Placed {
    pub at: [f64; 2],
    /// How far the seam point hangs past the layer below, mm (Orca's `unsupported_dist`), which the
    /// scarf seam condition reads.
    #[allow(dead_code, reason = "read by the scarf seam")]
    pub unsupported: f32,
}

/// Transcendental functions in double precision rounded to single: the platform's math library may
/// differ in the last bit of a single, which could flip a tied choice between native and WASM builds,
/// but a double result rounds to the same single everywhere.
fn exp32(x: f32) -> f32 {
    f64::from(x).m_exp() as f32
}
pub(crate) fn sin32(x: f32) -> f32 {
    f64::from(x).m_sin() as f32
}
pub(crate) fn cos32(x: f32) -> f32 {
    f64::from(x).m_cos() as f32
}
pub(crate) fn ln32(x: f32) -> f32 {
    f64::from(x).m_ln() as f32
}

fn gauss(value: f32, mean_x: f32, mean_value: f32, falloff: f32) -> f32 {
    let shifted = value - mean_x;
    let exponent = 1.0 / (falloff * shifted * shifted + 1.0);
    mean_value * (exp32(exponent) - 1.0) / (exp32(1.0) - 1.0)
}

/// `compute_angle_penalty`.
pub(crate) fn angle_penalty(ccw_angle: f32) -> f32 {
    gauss(ccw_angle, 0.0, 1.0, 3.0) + 1.0 / (2.0 + exp32(-ccw_angle))
}

fn dist2(a: V2, b: V2) -> f32 {
    (a[0] - b[0]).m_powi(2) + (a[1] - b[1]).m_powi(2)
}

/// The signed turn between two directions (`Slic3r::angle`).
fn turn(a: V2, b: V2) -> f32 {
    f64::from(a[0] * b[1] - a[1] * b[0]).m_atan2(f64::from(a[0] * b[0] + a[1] * b[1])) as f32
}

/// `calculate_polygon_angles_at_vertices`: the turn at every vertex between points at least
/// `arm` along the ring either way.
fn ring_angles(pts: &[V2], lengths: &[f32], arm: f32) -> Vec<f32> {
    let n = pts.len();
    let mut out = vec![0.0f32; n];
    if n < 3 {
        return out;
    }
    let next = |i: usize| (i + 1) % n;
    let prev = |i: usize| (i + n - 1) % n;
    let len = |i: usize| lengths.get(i).copied().unwrap_or(0.1);
    let (mut idx_prev, mut idx_next) = (0usize, 0usize);
    let (mut d_prev, mut d_next) = (0.0f32, 0.0f32);
    let mut guard = 0;
    while d_prev < arm && guard < 4 * n + 8 {
        idx_prev = prev(idx_prev);
        d_prev += len(idx_prev);
        guard += 1;
    }
    for curr in 0..n {
        let mut guard = 0;
        while d_prev - len(idx_prev) > arm && guard < 4 * n + 8 {
            d_prev -= len(idx_prev);
            idx_prev = next(idx_prev);
            guard += 1;
        }
        let mut guard = 0;
        while d_next < arm && guard < 4 * n + 8 {
            d_next += len(idx_next);
            idx_next = next(idx_next);
            guard += 1;
        }
        let (p0, p1, p2) = (
            pts.get(idx_prev).copied().unwrap_or_default(),
            pts.get(curr).copied().unwrap_or_default(),
            pts.get(idx_next).copied().unwrap_or_default(),
        );
        if let Some(o) = out.get_mut(curr) {
            *o = turn([p1[0] - p0[0], p1[1] - p0[1]], [p2[0] - p1[0], p2[1] - p1[1]]);
        }
        d_prev += len(curr);
        d_next -= len(curr);
    }
    out
}

/// The comparisons Orca's `SeamComparator` makes between candidates.
#[derive(Clone, Copy)]
struct Compare {
    mode: SeamPosition,
    importance: f32,
}

impl Compare {
    fn new(mode: SeamPosition) -> Self {
        Self {
            mode,
            importance: if mode == SeamPosition::Nearest {
                ANGLE_IMPORTANCE_NEAREST
            } else {
                ANGLE_IMPORTANCE_ALIGNED
            },
        }
    }

    #[allow(
        clippy::float_cmp,
        reason = "equal rear positions fall through to the score, as in Orca"
    )]
    fn aligned(self) -> bool {
        matches!(self.mode, SeamPosition::Aligned | SeamPosition::AlignedBack)
    }

    fn is_first_better(self, a: &Cand, b: &Cand, preferred: V2) -> bool {
        if self.aligned() && a.central != b.central {
            return a.central;
        }
        // Painted enforcers and blockers come first.
        if a.kind != b.kind {
            return a.kind > b.kind;
        }
        if a.overhang > 0.0 || b.overhang > 0.0 {
            return a.overhang < b.overhang;
        }
        // Hidden points (more than half a millimeter inside) first.
        if a.embedded < -0.5 && b.embedded > -0.5 {
            return true;
        }
        if b.embedded < -0.5 && a.embedded > -0.5 {
            return false;
        }
        if self.mode == SeamPosition::Back && (a.pos[1] - b.pos[1]).abs() > 0.0 {
            return a.pos[1] > b.pos[1];
        }
        let (mut da, mut db) = (0.0, 0.0);
        if self.mode == SeamPosition::Nearest {
            da = 1.0 - gauss(dist2([a.pos[0], a.pos[1]], preferred).sqrt(), 0.0, 1.0, 0.005);
            db = 1.0 - gauss(dist2([b.pos[0], b.pos[1]], preferred).sqrt(), 0.0, 1.0, 0.005);
        }
        let pa = a.overhang + a.visibility + self.importance * angle_penalty(a.angle) + da;
        let pb = b.overhang + b.visibility + self.importance * angle_penalty(b.angle) + db;
        pa < pb
    }

    fn is_first_not_much_worse(self, a: &Cand, b: &Cand, width: f32) -> bool {
        if self.aligned() && a.central != b.central {
            return a.central;
        }
        match a.kind {
            Kind::Enforced => return true,
            Kind::Blocked => return false,
            Kind::Neutral => {}
        }
        if a.kind != b.kind {
            return a.kind > b.kind;
        }
        if (a.overhang > 0.0 || b.overhang > 0.0) && (a.overhang - b.overhang).abs() > 0.1 * width {
            return a.overhang < b.overhang;
        }
        if a.embedded < -0.5 && b.embedded > -0.5 {
            return true;
        }
        if b.embedded < -0.5 && a.embedded > -0.5 {
            return false;
        }
        if self.mode == SeamPosition::Random {
            return true;
        }
        if self.mode == SeamPosition::Back {
            return a.pos[1] + ALIGN_SCORE_TOLERANCE * 5.0 > b.pos[1];
        }
        let pa = a.overhang + a.visibility + self.importance * angle_penalty(a.angle);
        let pb = b.overhang + b.visibility + self.importance * angle_penalty(b.angle);
        pa <= pb || pa - pb < ALIGN_SCORE_TOLERANCE
    }

    fn are_similar(self, a: &Cand, b: &Cand, width: f32) -> bool {
        self.is_first_not_much_worse(a, b, width) && self.is_first_not_much_worse(b, a, width)
    }

    /// Which of two candidates the planner takes: the better one, and between equals the rearmost, then
    /// the leftmost, so a tie does not depend on where the ring happens to start (Orca takes the first,
    /// which depends on its polygon).
    fn order(self, a: &Cand, b: &Cand) -> std::cmp::Ordering {
        if self.is_first_better(a, b, [0.0, 0.0]) {
            std::cmp::Ordering::Less
        } else if self.is_first_better(b, a, [0.0, 0.0]) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    }
}

impl Plan {
    /// Builds the plan. `visibility` is the surface visibility field when the mode wants it.
    pub(crate) fn build(
        layers: &[LayerIn],
        mode: SeamPosition,
        nozzle: f32,
        visibility: Option<&crate::raycast::Field>,
        faces: &[crate::seam::SeamFace],
    ) -> Self {
        let outlines: Vec<Support> = crate::par::map(layers, |l| Support::new(&l.outline));
        let idx: Vec<u32> = (0..u32::try_from(layers.len()).unwrap_or(u32::MAX)).collect();
        let mut built: Vec<LayerSeams> = crate::par::map(&idx, |&li| {
            let Some(layer) = layers.get(li as usize) else {
                return LayerSeams::default();
            };
            let prev = li.checked_sub(1).and_then(|p| outlines.get(p as usize));
            let here = outlines.get(li as usize);
            layer_candidates(layer, nozzle, visibility, prev, here, faces)
        });
        let cmp = Compare::new(mode);
        for ls in &mut built {
            let mut anchor: Option<V2> = None;
            for pi in 0..ls.perims.len() {
                if mode == SeamPosition::Nearest {
                    continue;
                }
                if mode == SeamPosition::Random {
                    pick_random(ls, pi);
                } else {
                    pick_best(ls, pi, cmp);
                    if cmp.aligned() {
                        anchor = settle_near(ls, pi, cmp, anchor);
                    }
                }
            }
        }
        let mut plan = Self {
            mode,
            layers: built,
            stagger: None,
        };
        if matches!(
            mode,
            SeamPosition::Aligned | SeamPosition::Back | SeamPosition::AlignedBack
        ) {
            plan.align(layers, cmp);
        }
        plan
    }

    /// The perimeter whose candidates lie nearest `ring`: the first ring point's nearest candidate,
    /// checked against the next one (Orca repeats until two consecutive points agree).
    fn perimeter_of(&self, layer: u32, ring: &[IntPoint<i32>]) -> Option<usize> {
        let ls = self.layers.get(layer as usize)?;
        if ls.pts.is_empty() {
            return None;
        }
        let nearest = |p: &IntPoint<i32>| -> Option<usize> {
            let q = [p.x as f32 / 10_000.0, p.y as f32 / 10_000.0];
            match &ls.grid {
                Some(g) => g.nearest(&ls.pts, q).and_then(|i| ls.pts.get(i)),
                None => ls
                    .pts
                    .iter()
                    .min_by(|a, b| dist2([a.pos[0], a.pos[1]], q).total_cmp(&dist2([b.pos[0], b.pos[1]], q))),
            }
            .map(|c| c.perim as usize)
        };
        let mut last: Option<usize> = None;
        for p in ring {
            let cur = nearest(p)?;
            if last == Some(cur) {
                return Some(cur);
            }
            last = Some(cur);
        }
        last
    }

    /// The point a wall ring starts at, or None when the layer has no ring near it. `last` is where the
    /// nozzle is (read by the nearest mode); an inner ring (`inner`) takes the seam of the outer ring
    /// beside it, projected onto itself.
    pub(crate) fn seam(
        &self,
        layer: u32,
        ring: &[IntPoint<i32>],
        inner: bool,
        last: [f64; 2],
    ) -> Option<Placed> {
        let pi = self.perimeter_of(layer, ring)?;
        let ls = self.layers.get(layer as usize)?;
        let per = ls.perims.get(pi)?;
        let (seam_index, pos): (usize, V3) = if per.finalized {
            (per.seam as usize, per.fin)
        } else if self.mode == SeamPosition::Nearest {
            let cmp = Compare::new(SeamPosition::Nearest);
            let preferred = [last[0] as f32, last[1] as f32];
            let mut best = per.start as usize;
            for i in per.start as usize..per.end as usize {
                if let (Some(a), Some(b)) = (ls.pts.get(i), ls.pts.get(best))
                    && cmp.is_first_better(a, b, preferred)
                {
                    best = i;
                }
            }
            (best, ls.pts.get(best)?.pos)
        } else {
            (per.seam as usize, ls.pts.get(per.seam as usize)?.pos)
        };
        let cand = ls.pts.get(seam_index)?;
        let mut at = [f64::from(pos[0]), f64::from(pos[1])];
        if inner {
            let (foot, mut depth, mut seg) = closest_on_ring(ring, at)?;
            let beta = cos32(cand.angle / 2.0);
            let (a, b) = (per.start as usize, per.end as usize);
            let prev_i = if seam_index == a { b - 1 } else { seam_index - 1 };
            let next_i = if seam_index + 1 == b { a } else { seam_index + 1 };
            let pc = [f64::from(cand.pos[0]), f64::from(cand.pos[1])];
            let off = (at[0] - pc[0]).m_powi(2) + (at[1] - pc[1]).m_powi(2);
            let mut foot = foot;
            if off < depth && cand.angle < -1e-6 {
                // The outer wall's seam sits in a concave corner: the inner seam goes into the corner too.
                let dir = |q: V3| {
                    let d = [pc[0] - f64::from(q[0]), pc[1] - f64::from(q[1])];
                    let l = d[0].m_hypot(d[1]).max(1e-12);
                    [d[0] / l, d[1] / l]
                };
                let (dp, dn) = (dir(ls.pts.get(prev_i)?.pos), dir(ls.pts.get(next_i)?.pos));
                let mid = [f64::midpoint(dp[0], dn[0]), f64::midpoint(dp[1], dn[1])];
                depth = std::f64::consts::SQRT_2 * depth / f64::from(beta);
                let target = [pc[0] + depth * mid[0], pc[1] + depth * mid[1]];
                (foot, _, seg) = closest_on_ring(ring, target)?;
            } else {
                // The perpendicular depth, not the distance to the nearest point (it matters in convex corners).
                depth = depth * f64::from(beta) / std::f64::consts::SQRT_2;
            }
            if let Some(width) = self.stagger {
                // Staggering: walk the seam back along the loop by the wall's depth (at least one width).
                let mut left = depth.max(width);
                let n = ring.len();
                let mut here = foot;
                while left > 0.0 {
                    seg = (seg + 1) % n;
                    let p = ring.get(seg)?;
                    let next = [f64::from(p.x) / 10_000.0, f64::from(p.y) / 10_000.0];
                    let dist = (next[0] - here[0]).m_hypot(next[1] - here[1]);
                    let reached = if dist > left && dist > 0.0 {
                        [
                            here[0] + (next[0] - here[0]) * left / dist,
                            here[1] + (next[1] - here[1]) * left / dist,
                        ]
                    } else {
                        next
                    };
                    left -= dist;
                    here = reached;
                    if n == 0 {
                        break;
                    }
                }
                foot = here;
            }
            at = foot;
        }
        Some(Placed {
            at,
            unsupported: cand.unsupported,
        })
    }

    /// Orca `align_seam_points`: strings of neighboring layers' seams, each fitted by a cubic B-spline.
    #[allow(clippy::too_many_lines)]
    fn align(&mut self, layers: &[LayerIn], cmp: Compare) {
        let _ = layers;
        // Every ring's seam: (layer, point).
        let mut seams: Vec<(usize, usize)> = Vec::new();
        for (li, ls) in self.layers.iter().enumerate() {
            for p in &ls.perims {
                seams.push((li, p.seam as usize));
            }
        }
        {
            let layers = &self.layers;
            crate::sorting::sort_by(&mut seams, |a, b| {
                match (
                    layers.get(a.0).and_then(|l| l.pts.get(a.1)),
                    layers.get(b.0).and_then(|l| l.pts.get(b.1)),
                ) {
                    (Some(x), Some(y)) => cmp.order(x, y),
                    _ => std::cmp::Ordering::Equal,
                }
            });
        }
        let mut gi = 0usize;
        while gi < seams.len() {
            let Some(&(li, si)) = seams.get(gi) else { break };
            gi += 1;
            let done = self
                .layers
                .get(li)
                .and_then(|l| l.pts.get(si))
                .and_then(|c| self.layers.get(li)?.perims.get(c.perim as usize))
                .is_none_or(|p| p.finalized);
            if done {
                continue;
            }
            let mut string = self.seam_string((li, si), cmp);
            let step = 1 + string.len() / 20;
            let mut alt = 0;
            while alt < string.len() {
                let Some(&(sl, sp)) = string.get(alt) else { break };
                let start_seam = self
                    .layers
                    .get(sl)
                    .and_then(|l| {
                        let c = l.pts.get(sp)?;
                        Some(l.perims.get(c.perim as usize)?.seam as usize)
                    })
                    .unwrap_or(sp);
                let other = self.seam_string((sl, start_seam), cmp);
                if other.len() > string.len() {
                    string = other;
                }
                alt += step;
            }
            if string.len() < ALIGN_MINIMUM_STRING_SEAMS {
                continue;
            }
            crate::sorting::sort_by_key(&mut string, |s| s.0);
            // The current seam may have been skipped for an alternative string; look at it again.
            gi -= 1;
            self.fit_string(&string, cmp);
        }
    }

    fn cand(&self, key: (usize, usize)) -> Option<&Cand> {
        self.layers.get(key.0)?.pts.get(key.1)
    }

    /// Orca `find_seam_string`: seams of the layers above, then below, that lie within a few line widths
    /// of the last one and score about as well as their ring's own seam.
    fn seam_string(&self, start: (usize, usize), cmp: Compare) -> Vec<(usize, usize)> {
        let mut string = vec![start];
        let Some(first) = self.cand(start) else {
            return string;
        };
        let width = self
            .layers
            .get(start.0)
            .and_then(|l| l.perims.get(first.perim as usize))
            .map_or(0.4, |p| p.width);
        let max_distance = ALIGN_TOLERABLE_DIST_FACTOR * width;
        let count = self.layers.len() as i64;
        let mut step = 1i64;
        let mut next = start.0 as i64 + 1;
        let mut prev = start;
        if next >= count {
            step = -1;
            prev = start;
            next = start.0 as i64 - 1;
        }
        while next >= 0 {
            if next >= count {
                step = -1;
                prev = start;
                next = start.0 as i64 - 1;
                if next < 0 {
                    break;
                }
            }
            let Some(prev_pos) = self.cand(prev).map(|c| c.pos) else {
                break;
            };
            match self.next_seam_in_layer(prev_pos, next as usize, max_distance, cmp) {
                Some(found) => {
                    string.push(found);
                    prev = found;
                }
                None if step == 1 => {
                    step = -1;
                    prev = start;
                    next = start.0 as i64 - 1;
                    if next < 0 {
                        break;
                    }
                    continue;
                }
                None => break,
            }
            next += step;
        }
        string
    }

    /// Orca `find_next_seam_in_layer`.
    fn next_seam_in_layer(
        &self,
        projected: V3,
        layer: usize,
        max_distance: f32,
        cmp: Compare,
    ) -> Option<(usize, usize)> {
        let ls = self.layers.get(layer)?;
        let target = [projected[0], projected[1]];
        let limit = max_distance * max_distance;
        let close = |c: &Cand| dist2([c.pos[0], c.pos[1]], target) <= limit;
        // The grid gives the candidates near the target; the same test then keeps the same ones, in order.
        let near: Vec<usize> = match &ls.grid {
            Some(g) => g.within(&ls.pts, target, max_distance, close),
            None => (0..ls.pts.len())
                .filter(|&i| ls.pts.get(i).is_some_and(close))
                .collect(),
        };
        let first = *near.first()?;
        let finalized = |i: usize| {
            ls.pts
                .get(i)
                .and_then(|c| ls.perims.get(c.perim as usize))
                .is_none_or(|p| p.finalized)
        };
        let (mut best, mut nearest) = (first, first);
        for &i in &near {
            if finalized(i) {
                continue;
            }
            let (Some(c), Some(b), Some(n)) = (ls.pts.get(i), ls.pts.get(best), ls.pts.get(nearest)) else {
                continue;
            };
            if cmp.is_first_better(c, b, target) || finalized(best) {
                best = i;
            }
            let d = |p: &Cand| dist2([p.pos[0], p.pos[1]], target);
            if d(c) < d(n) || finalized(nearest) {
                nearest = i;
            }
        }
        if finalized(nearest) {
            return None;
        }
        let nearest_c = ls.pts.get(nearest)?;
        let next_layer_seam = ls
            .pts
            .get(ls.perims.get(nearest_c.perim as usize)?.seam as usize)?;
        let width = ls.perims.get(nearest_c.perim as usize)?.width;
        // A central enforcer within three reaches is taken first.
        if next_layer_seam.central
            && dist2([next_layer_seam.pos[0], next_layer_seam.pos[1]], target) < 9.0 * limit
        {
            return Some((layer, ls.perims.get(nearest_c.perim as usize)?.seam as usize));
        }
        if cmp.is_first_not_much_worse(nearest_c, next_layer_seam, width) {
            return Some((layer, nearest));
        }
        let best_c = ls.pts.get(best)?;
        if cmp.is_first_not_much_worse(best_c, next_layer_seam, width) {
            return Some((layer, best));
        }
        None
    }

    /// Fits the seam string with a cubic B-spline over height and stores the fitted points.
    fn fit_string(&mut self, string: &[(usize, usize)], cmp: Compare) {
        let n = string.len();
        let mut obs: Vec<V2> = Vec::with_capacity(n);
        let mut zs: Vec<f32> = Vec::with_capacity(n);
        let mut weights: Vec<f32> = Vec::with_capacity(n);
        let mut total = 0.0f32;
        let Some(mut last) = string.first().and_then(|&k| self.cand(k)).map(|c| c.pos) else {
            return;
        };
        for (i, &key) in string.iter().enumerate() {
            let Some(cur) = self.cand(key) else { return };
            let mut layer_angle = 0.0f32;
            if i > 0 && i + 1 < n {
                let (Some(p), Some(q)) = (
                    string.get(i - 1).and_then(|&k| self.cand(k)),
                    string.get(i + 1).and_then(|&k| self.cand(k)),
                ) else {
                    return;
                };
                let a = [
                    cur.pos[0] - p.pos[0],
                    cur.pos[1] - p.pos[1],
                    cur.pos[2] - p.pos[2],
                ];
                let b = [
                    q.pos[0] - cur.pos[0],
                    q.pos[1] - cur.pos[1],
                    q.pos[2] - cur.pos[2],
                ];
                let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
                let na = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt().max(1e-12);
                let nb = (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]).sqrt().max(1e-12);
                layer_angle = f64::from((dot / (na * nb)).clamp(-1.0, 1.0)).m_acos().abs() as f32;
            }
            obs.push([cur.pos[0], cur.pos[1]]);
            zs.push(cur.pos[2]);
            let mut weight = 1.0 / (0.1 + angle_penalty(cur.angle));
            let mut curling = if layer_angle > 2.0 * cur.angle.abs() {
                -0.8
            } else {
                1.0
            };
            if cur.kind == Kind::Enforced {
                curling = 1.0;
                weight += 3.0;
            }
            weights.push(weight);
            let d = [cur.pos[0] - last[0], cur.pos[1] - last[1], cur.pos[2] - last[2]];
            total += curling * (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            last = cur.pos;
        }
        if cmp.mode == SeamPosition::Back {
            total *= 0.3;
        }
        let segments = ((total.max(0.0) / ALIGN_MM_PER_SEGMENT) as usize).clamp(1, n);
        let Some(curve) = fit_cubic_bspline(&obs, &zs, &weights, segments) else {
            return;
        };
        for &key in string {
            let Some(cur) = self.cand(key).cloned() else {
                continue;
            };
            let mut t = (cur.angle.abs() / SHARP_ANGLE_SNAPPING).m_powi(3).min(1.0);
            if cur.kind == Kind::Enforced {
                t = t.max(0.4);
            }
            let fitted = curve.at(cur.pos[2]);
            let fin = [
                t * cur.pos[0] + (1.0 - t) * fitted[0],
                t * cur.pos[1] + (1.0 - t) * fitted[1],
                cur.pos[2],
            ];
            if let Some(p) = self
                .layers
                .get_mut(key.0)
                .and_then(|l| l.perims.get_mut(cur.perim as usize))
            {
                p.seam = u32::try_from(key.1).unwrap_or(0);
                p.fin = fin;
                p.finalized = true;
            }
        }
    }
}

/// The ring rotated to start at the point of it nearest `at` (mm): at a vertex when one lies within
/// 1.5 micrometers, else at a new vertex on the nearest edge (Orca's `split_at_vertex`, then `split_at`).
pub(crate) fn start_at(ring: &[IntPoint<i32>], at: [f64; 2]) -> Option<Vec<IntPoint<i32>>> {
    let n = ring.len();
    if n < 3 {
        return None;
    }
    let mut best: Option<(usize, f64, f64)> = None;
    for i in 0..n {
        let (a, b) = (ring.get(i)?, ring.get((i + 1) % n)?);
        let (ax, ay) = (f64::from(a.x) / 10_000.0, f64::from(a.y) / 10_000.0);
        let (dx, dy) = (f64::from(b.x) / 10_000.0 - ax, f64::from(b.y) / 10_000.0 - ay);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 {
            (((at[0] - ax) * dx + (at[1] - ay) * dy) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let d2 = (at[0] - (ax + t * dx)).m_powi(2) + (at[1] - (ay + t * dy)).m_powi(2);
        if best.is_none_or(|(_, _, bd)| d2 < bd) {
            best = Some((i, t, d2));
        }
    }
    let (i, t, _) = best?;
    let (a, b) = (*ring.get(i)?, *ring.get((i + 1) % n)?);
    let foot = IntPoint::new(
        (f64::from(a.x) + t * f64::from(b.x - a.x)).round() as i32,
        (f64::from(a.y) + t * f64::from(b.y - a.y)).round() as i32,
    );
    let close =
        |p: IntPoint<i32>| (i64::from(p.x - foot.x)).pow(2) + (i64::from(p.y - foot.y)).pow(2) <= 15 * 15;
    let mut out: Vec<IntPoint<i32>> = Vec::with_capacity(n + 1);
    if close(a) {
        out.extend((0..n).filter_map(|k| ring.get((i + k) % n).copied()));
    } else if close(b) {
        out.extend((0..n).filter_map(|k| ring.get((i + 1 + k) % n).copied()));
    } else {
        out.push(foot);
        out.extend((1..=n).filter_map(|k| ring.get((i + k) % n).copied()));
    }
    Some(out)
}

/// The nearest point on a closed ring to `at` (mm), and its distance, mm squared.
fn closest_on_ring(ring: &[IntPoint<i32>], at: [f64; 2]) -> Option<([f64; 2], f64, usize)> {
    let n = ring.len();
    let mut best: Option<([f64; 2], f64, usize)> = None;
    for i in 0..n {
        let (a, b) = (ring.get(i)?, ring.get((i + 1) % n)?);
        let (ax, ay) = (f64::from(a.x) / 10_000.0, f64::from(a.y) / 10_000.0);
        let (dx, dy) = (f64::from(b.x) / 10_000.0 - ax, f64::from(b.y) / 10_000.0 - ay);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 {
            (((at[0] - ax) * dx + (at[1] - ay) * dy) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (cx, cy) = (ax + t * dx, ay + t * dy);
        let d2 = (at[0] - cx).m_powi(2) + (at[1] - cy).m_powi(2);
        if best.is_none_or(|(_, bd, _)| d2 < bd) {
            best = Some(([cx, cy], d2, i));
        }
    }
    best
}

#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
fn layer_candidates(
    layer: &LayerIn,
    nozzle: f32,
    visibility: Option<&crate::raycast::Field>,
    prev: Option<&Support>,
    here: Option<&Support>,
    all_faces: &[crate::seam::SeamFace],
) -> LayerSeams {
    let mut out = LayerSeams::default();
    // Painted faces that can reach this layer: an edge near an enforcer is searched at its own length.
    let reach = layer
        .rings
        .iter()
        .flat_map(|(r, _)| r.windows(2))
        .map(|w| ((f64::from(w[0].x - w[1].x)).m_hypot(f64::from(w[0].y - w[1].y))) / 10_000.0)
        .fold(1.0f64, f64::max);
    let z = f64::from(layer.z);
    let faces: Vec<crate::seam::SeamFace> = all_faces
        .iter()
        .filter(|f| {
            let zs = f.tri.map(|v| v[2]);
            zs[0].min(zs[1]).min(zs[2]) <= z + reach && zs[0].max(zs[1]).max(zs[2]) >= z - reach
        })
        .copied()
        .collect();
    for (ring, width) in &layer.rings {
        if ring.len() < 3 {
            continue;
        }
        let pts: Vec<V2> = ring
            .iter()
            .map(|p| [p.x as f32 / 10_000.0, p.y as f32 / 10_000.0])
            .collect();
        let area2: f32 = (0..pts.len())
            .map(|i| {
                let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                a[0] * b[1] - b[0] * a[1]
            })
            .sum();
        let clockwise = area2 < 0.0;
        let mut ccw = pts;
        if clockwise {
            ccw.reverse();
        }
        // Orca's candidates start where its polygon does, which for a Clipper ring is the lowest vertex,
        // the leftmost of them; a tie between equal candidates goes to the one that comes first.
        if let Some(first) = (0..ccw.len()).min_by(|&a, &b| {
            ccw[a][1]
                .total_cmp(&ccw[b][1])
                .then(ccw[a][0].total_cmp(&ccw[b][0]))
        }) {
            ccw.rotate_left(first);
        }
        let n = ccw.len();
        let mut lengths: Vec<f32> = (0..n - 1).map(|i| dist2(ccw[i], ccw[i + 1]).sqrt()).collect();
        lengths.push(dist2(ccw[0], ccw[n - 1]).sqrt().max(0.1));
        let angles = ring_angles(&ccw, &lengths, nozzle);
        let pi = u32::try_from(out.perims.len()).unwrap_or(0);
        let start = u32::try_from(out.pts.len()).unwrap_or(0);
        let width = *width;
        let classify = |x: f32, y: f32| -> Kind {
            if faces.is_empty() {
                return Kind::Neutral;
            }
            let at = [f64::from(x), f64::from(y), z];
            if crate::seam::near(at, &faces, false, f64::from(width)) {
                Kind::Blocked
            } else if crate::seam::near(at, &faces, true, f64::from(width)) {
                Kind::Enforced
            } else {
                Kind::Neutral
            }
        };
        let make = |x: f32, y: f32, angle: f32, kind: Kind| -> Cand {
            let pos = [x, y, layer.z];
            let mut cand = Cand {
                kind,
                central: false,
                pos,
                perim: pi,
                visibility: 0.0,
                overhang: 0.0,
                unsupported: 0.0,
                embedded: 0.0,
                angle,
            };
            if let Some(f) = visibility {
                cand.visibility = f.at(pos);
            }
            let pt = IntPoint::new((x * 10_000.0).round() as i32, (y * 10_000.0).round() as i32);
            if let Some(below) = prev {
                let d = below.signed_distance(pt) as f32;
                cand.overhang = (d + 0.65 * width - OVERHANG_ANGLE_TAN * layer.height).max(0.0);
                cand.unsupported = d + 0.4 * width;
            }
            if layer.multi
                && let Some(h) = here
            {
                cand.embedded = h.signed_distance(pt) as f32 + 0.65 * width;
            }
            cand
        };
        for (i, p) in ccw.iter().enumerate() {
            let a = angles.get(i).copied().unwrap_or(0.0);
            out.pts.push(make(
                p[0],
                p[1],
                if clockwise { -a } else { a },
                classify(p[0], p[1]),
            ));
            // An edge near an enforcer gets a point every 0.2 mm, so the seam can land inside the stretch.
            if !faces.is_empty() {
                let next = ccw[(i + 1) % n];
                let len = dist2(*p, next).sqrt();
                let at = [f64::from(p[0]), f64::from(p[1]), z];
                if len > crate::seam::OVERSAMPLE_MM as f32
                    && crate::seam::near(at, &faces, true, f64::from(len))
                {
                    let mut step = crate::seam::OVERSAMPLE_MM as f32;
                    while step < len {
                        let (x, y) = (
                            p[0] + (next[0] - p[0]) * step / len,
                            p[1] + (next[1] - p[1]) * step / len,
                        );
                        out.pts.push(make(x, y, 0.0, classify(x, y)));
                        step += crate::seam::OVERSAMPLE_MM as f32;
                    }
                }
            }
        }
        if let Some(slice) = out.pts.get_mut(start as usize..) {
            mark_central(slice);
        }
        out.perims.push(Perim {
            start,
            end: u32::try_from(out.pts.len()).unwrap_or(0),
            seam: start,
            width,
            finalized: false,
            fin: [0.0; 3],
        });
    }
    out.grid = Grid::new(&out.pts);
    out
}

/// Orca's central enforcer: among the stretches of enforced points of a ring, the middle of the longest one,
/// or the middle of its points that turn by more than 55 degrees when it has any.
fn mark_central(pts: &mut [Cand]) {
    let n = pts.len();
    if n == 0 || !pts.iter().any(|c| c.kind == Kind::Enforced) {
        return;
    }
    let is = |c: &[Cand], i: usize| c.get(i % n).is_some_and(|x| x.kind == Kind::Enforced);
    // Starts and ends of stretches, in order around the ring.
    let mut marks: Vec<usize> = Vec::new();
    for i in 0..n {
        let (cur, next) = (is(pts, i), is(pts, i + 1));
        if cur != next {
            marks.push((i + 1) % n);
        }
    }
    // The whole ring enforced: nothing to pick.
    if marks.is_empty() {
        return;
    }
    let start_on_second = !is(pts, marks[0]);
    if start_on_second {
        marks.push(marks[0]);
    }
    let len = |s: usize, e: usize| if e < s { s + (n - e) } else { e - s };
    let mut best = (0usize, 0usize);
    let mut k = usize::from(start_on_second);
    while k + 1 < marks.len() {
        let cur = (marks[k], marks[k + 1]);
        if len(best.0, best.1) < len(cur.0, cur.1) {
            best = cur;
        }
        k += 2;
    }
    let mut viable: Vec<usize> = Vec::new();
    let mut sharp: Vec<usize> = Vec::new();
    let mut i = best.0;
    let mut guard = 0;
    while i != best.1 && guard <= n {
        viable.push(i);
        if pts.get(i).is_some_and(|c| c.angle.abs() > SHARP_ANGLE_SNAPPING) {
            sharp.push(i);
        }
        i = (i + 1) % n;
        guard += 1;
    }
    let pick = if sharp.is_empty() {
        viable.get(viable.len() / 2).copied()
    } else {
        sharp.get(sharp.len() / 2).copied()
    };
    if let Some(c) = pick.and_then(|i| pts.get_mut(i)) {
        c.central = true;
    }
}

fn pick_best(ls: &mut LayerSeams, pi: usize, cmp: Compare) {
    let Some(p) = ls.perims.get(pi) else { return };
    let (a, b) = (p.start as usize, p.end as usize);
    let mut best = a;
    for i in a..b {
        if let (Some(x), Some(y)) = (ls.pts.get(i), ls.pts.get(best))
            && cmp.order(x, y) == std::cmp::Ordering::Less
        {
            best = i;
        }
    }
    if let Some(p) = ls.perims.get_mut(pi) {
        p.seam = u32::try_from(best).unwrap_or(0);
    }
}

/// Visibility read from a few dozen rays per sample varies by about a hundredth between points that are
/// equally exposed, so scores closer than this are ties.
const SCORE_NOISE: f32 = 0.02;

/// An aligned seam among ties: when the ring's points score within `SCORE_NOISE` of its best (a round
/// hole, a cylinder), the seam goes to the one nearest `anchor`, the seam of the ring before it on the
/// layer, instead of wherever the ties happen to fall. The nozzle then steps from one ring to the next
/// without a travel and a retraction (Orca's pick among such ties depends on its random rays, and on the
/// eccentric ring put the hole's seam a quarter turn from the outline's). Returns this ring's seam.
fn settle_near(ls: &mut LayerSeams, pi: usize, cmp: Compare, anchor: Option<V2>) -> Option<V2> {
    let p = ls.perims.get(pi)?.clone();
    let best = ls.pts.get(p.seam as usize)?.clone();
    let score = |c: &Cand| c.overhang + c.visibility + cmp.importance * angle_penalty(c.angle);
    let mut seam = p.seam as usize;
    if let Some(at) = anchor {
        let tied = |c: &Cand| {
            c.kind == best.kind
                && c.central == best.central
                && c.overhang <= 0.0
                && best.overhang <= 0.0
                && (c.embedded < -0.5) == (best.embedded < -0.5)
                && score(c) - score(&best) < SCORE_NOISE
        };
        let mut near = dist2([best.pos[0], best.pos[1]], at);
        for i in p.start as usize..p.end as usize {
            let Some(c) = ls.pts.get(i) else { continue };
            let d = dist2([c.pos[0], c.pos[1]], at);
            if d < near && tied(c) {
                (seam, near) = (i, d);
            }
        }
        if let Some(q) = ls.perims.get_mut(pi) {
            q.seam = u32::try_from(seam).unwrap_or(q.seam);
        }
    }
    ls.pts.get(seam).map(|c| [c.pos[0], c.pos[1]])
}

/// Orca `pick_random_seam_point`: among the points as good as the best, one chosen along the edges by
/// a number from the position of the ring's first point; the seam lands anywhere along its edge.
fn pick_random(ls: &mut LayerSeams, pi: usize) {
    let cmp = Compare::new(SeamPosition::Random);
    let Some(p) = ls.perims.get(pi).cloned() else {
        return;
    };
    let (a, b) = (p.start as usize, p.end as usize);
    let Some(seed) = ls.pts.get(a).map(|c| c.pos) else {
        return;
    };
    let mut rand = (sin32(seed[0] * 12.9898 + seed[1] * 78.233 + seed[2] * 133.3333) * 43_758.547).abs();
    rand -= rand.trunc();
    let width = p.width;
    let edge = |i: usize| -> (V3, f32) {
        let next = if i + 1 == b { a } else { i + 1 };
        let (u, v) = (
            ls.pts.get(i).map_or([0.0; 3], |c| c.pos),
            ls.pts.get(next).map_or([0.0; 3], |c| c.pos),
        );
        let d = [v[0] - u[0], v[1] - u[1], v[2] - u[2]];
        (d, (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt())
    };
    let mut example = a;
    let mut viables: Vec<(usize, V3, f32)> = Vec::new();
    for i in a..b {
        let (Some(ci), Some(ce)) = (ls.pts.get(i), ls.pts.get(example)) else {
            continue;
        };
        if cmp.are_similar(ci, ce, width) {
            let (d, l) = edge(i);
            viables.push((i, d, l));
        } else if cmp.is_first_not_much_worse(ce, ci, width) {
            // Worse than the example: skipped.
        } else {
            example = i;
            viables.clear();
            let (d, l) = edge(i);
            viables.push((i, d, l));
        }
    }
    let sum: f32 = viables.iter().map(|v| v.2).sum();
    let mut picked = sum * rand;
    let mut k = 0usize;
    while viables.get(k).is_some_and(|v| picked - v.2 > 0.0) && k + 1 < viables.len() {
        picked -= viables.get(k).map_or(0.0, |v| v.2);
        k += 1;
    }
    let Some(&(idx, d, l)) = viables.get(k) else {
        return;
    };
    let base = ls.pts.get(idx).map_or([0.0; 3], |c| c.pos);
    let fin = if l > 0.0 {
        [
            base[0] + d[0] / l * picked,
            base[1] + d[1] / l * picked,
            base[2] + d[2] / l * picked,
        ]
    } else {
        base
    };
    if let Some(p) = ls.perims.get_mut(pi) {
        p.seam = u32::try_from(idx).unwrap_or(0);
        p.fin = fin;
        p.finalized = true;
    }
}

/// A fitted curve: coefficients of a uniform cubic B-spline over the observation heights.
struct Curve {
    start: f32,
    size: f32,
    coef: Vec<V2>,
}

fn kernel(x: f32) -> f32 {
    let x = x.abs();
    if x >= 2.0 {
        0.0
    } else if x <= 1.0 {
        4.0 / 6.0 + 0.0 * x - x * x + 0.5 * x * x * x
    } else {
        let y = x - 1.0;
        1.0 / 6.0 - 0.5 * y + 0.5 * y * y - (1.0 / 6.0) * y * y * y
    }
}

impl Curve {
    fn at(&self, z: f32) -> V2 {
        let mut out = [0.0f32; 2];
        let mid = ((z - self.start) / self.size).floor() as i64;
        let first = mid - 2 + 1;
        for s in first..first + 4 {
            let seg_start = self.start + s as f32 * self.size;
            let d = (seg_start - z) / self.size;
            let pi = s.clamp(0, self.coef.len() as i64 - 1) as usize;
            let w = kernel(d);
            if let Some(c) = self.coef.get(pi) {
                out[0] += w * c[0];
                out[1] += w * c[1];
            }
        }
        out
    }
}

/// Orca `Geometry::fit_cubic_bspline`: weighted least squares over `segments + 1` coefficients.
/// (Solved through the normal equations; a coefficient nothing refers to stays zero.)
#[allow(clippy::needless_range_loop)]
fn fit_cubic_bspline(obs: &[V2], zs: &[f32], weights: &[f32], segments: usize) -> Option<Curve> {
    let m = obs.len();
    if m == 0 || segments == 0 {
        return None;
    }
    let start = *zs.first()?;
    let length = zs.last()? - start;
    let size = length / segments as f32;
    if size <= 0.0 || !size.is_finite() {
        return None;
    }
    let p = segments + 1;
    // Rows of T (sparse: four entries each).
    let mut rows: Vec<[(usize, f64); 4]> = Vec::with_capacity(m);
    for i in 0..m {
        let z = *zs.get(i)?;
        let sw = f64::from(weights.get(i)?.sqrt());
        let mid = ((z - start) / size).floor() as i64;
        let first = mid - 2 + 1;
        let mut r = [(0usize, 0.0f64); 4];
        for (k, s) in (first..first + 4).enumerate() {
            let seg_start = start + s as f32 * size;
            let d = (seg_start - z) / size;
            let pi = s.clamp(0, p as i64 - 1) as usize;
            r[k] = (pi, f64::from(kernel(d)) * sw);
        }
        rows.push(r);
    }
    let mut ata = vec![vec![0.0f64; p]; p];
    let mut atb = vec![[0.0f64; 2]; p];
    for (i, r) in rows.iter().enumerate() {
        let sw = f64::from(weights.get(i)?.sqrt());
        let o = obs.get(i)?;
        for &(a, wa) in r {
            for &(b, wb) in r {
                ata[a][b] += wa * wb;
            }
            atb[a][0] += wa * f64::from(o[0]) * sw;
            atb[a][1] += wa * f64::from(o[1]) * sw;
        }
    }
    for i in 0..p {
        ata[i][i] += 1e-9;
    }
    // Gaussian elimination with partial pivoting.
    let mut a = ata;
    let mut b = atb;
    for col in 0..p {
        let piv = (col..p).max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))?;
        a.swap(col, piv);
        b.swap(col, piv);
        let d = a[col][col];
        if d.abs() < 1e-18 {
            continue;
        }
        for row in col + 1..p {
            let f = a[row][col] / d;
            if f == 0.0 {
                continue;
            }
            for k in col..p {
                a[row][k] -= f * a[col][k];
            }
            b[row][0] -= f * b[col][0];
            b[row][1] -= f * b[col][1];
        }
    }
    let mut x = vec![[0.0f64; 2]; p];
    for col in (0..p).rev() {
        let mut s = b[col];
        for k in col + 1..p {
            s[0] -= a[col][k] * x[k][0];
            s[1] -= a[col][k] * x[k][1];
        }
        let d = a[col][col];
        x[col] = if d.abs() < 1e-18 {
            [0.0, 0.0]
        } else {
            [s[0] / d, s[1] / d]
        };
    }
    Some(Curve {
        start,
        size,
        coef: x.iter().map(|c| [c[0] as f32, c[1] as f32]).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concave_corners_score_best_and_flat_walls_worst() {
        assert!(angle_penalty(-1.0) < angle_penalty(1.0));
        assert!(angle_penalty(1.0) < angle_penalty(0.0));
    }

    #[test]
    fn the_spline_follows_a_straight_line() {
        let zs: Vec<f32> = (0..30).map(|i| i as f32 * 0.2).collect();
        let obs: Vec<V2> = zs.iter().map(|z| [10.0 + 0.5 * z, 5.0 - 0.25 * z]).collect();
        let w = vec![1.0f32; zs.len()];
        let c = fit_cubic_bspline(&obs, &zs, &w, 3).unwrap();
        for z in [0.0f32, 1.7, 3.1, 5.8] {
            let p = c.at(z);
            assert!((p[0] - (10.0 + 0.5 * z)).abs() < 0.05, "{z} {p:?}");
            assert!((p[1] - (5.0 - 0.25 * z)).abs() < 0.05, "{z} {p:?}");
        }
    }

    fn square(c: f32, h: f32, z: f32) -> LayerIn {
        let p = |x: f32, y: f32| IntPoint::new(((c + x) * 10_000.0) as i32, ((c + y) * 10_000.0) as i32);
        let ring = vec![p(-h, -h), p(h, -h), p(h, h), p(-h, h)];
        LayerIn {
            z,
            height: 0.2,
            rings: vec![(ring.clone(), 0.42)],
            outline: vec![vec![ring]],
            multi: false,
        }
    }

    #[test]
    fn a_square_gets_its_seam_in_a_corner_on_every_layer_and_they_align() {
        let layers: Vec<LayerIn> = (0..40)
            .map(|i| square(100.0, 10.0, 0.2 * (i + 1) as f32))
            .collect();
        let plan = Plan::build(&layers, SeamPosition::Aligned, 0.4, None, &[]);
        let ring = layers[5].rings[0].0.clone();
        let mut at: Vec<[f64; 2]> = Vec::new();
        for l in 0..40u32 {
            let s = plan.seam(l, &ring, false, [0.0, 0.0]).unwrap();
            at.push(s.at);
        }
        let near_corner = |p: &[f64; 2]| {
            [90.0, 110.0].iter().any(|x| (p[0] - x).abs() < 0.2)
                && [90.0, 110.0].iter().any(|y| (p[1] - y).abs() < 0.2)
        };
        assert!(at.iter().all(near_corner), "{at:?}");
        assert!(
            at.windows(2)
                .all(|w| (w[0][0] - w[1][0]).abs() < 0.01 && (w[0][1] - w[1][1]).abs() < 0.01)
        );
    }

    #[test]
    fn rear_puts_the_seam_at_the_back() {
        let layers: Vec<LayerIn> = (0..12)
            .map(|i| square(100.0, 10.0, 0.2 * (i + 1) as f32))
            .collect();
        let plan = Plan::build(&layers, SeamPosition::Back, 0.4, None, &[]);
        let ring = layers[0].rings[0].0.clone();
        let s = plan.seam(3, &ring, false, [0.0, 0.0]).unwrap();
        assert!((s.at[1] - 110.0).abs() < 0.2, "{s:?}");
    }
}
