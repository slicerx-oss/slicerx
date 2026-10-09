// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Painted colors on a model: reading the per-triangle `paint_color` text of Bambu and Orca 3MF
//! files, and turning painted surfaces into color regions of a layer.
//!
//! The text is a stream of 4-bit codes, written last code first. A code is a leaf (bits 0 and 1
//! are 0, the painted filament follows in bits 2 and 3, or in the next code plus 3 when bits 2 and
//! 3 are both set) or a split (bits 0 and 1 count the split sides, 1 to 3, and bits 2 and 3 name
//! the special corner), followed by its children in order. The layout of the children below was
//! worked out against what `OrcaSlicer` prints for hand-written codes (`fit_paint.py` in the
//! benchmark folder checks it, including random nested codes).

/// A painted piece of a triangle, in mm; `state` is the 1-based filament.
use crate::fm::Fm as _;
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PaintFacet {
    pub v: [[f32; 3]; 3],
    pub state: u8,
}

type P = [f64; 3];

fn mid(a: P, b: P) -> P {
    [
        f64::midpoint(a[0], b[0]),
        f64::midpoint(a[1], b[1]),
        f64::midpoint(a[2], b[2]),
    ]
}

/// The nibbles of a paint text in stream order (the text is written backwards).
fn nibbles(text: &str) -> Option<Vec<u8>> {
    text.chars()
        .rev()
        .map(|c| c.to_digit(16).and_then(|d| u8::try_from(d).ok()))
        .collect()
}

/// Deepest nesting read, so a broken text cannot run away.
const MAX_DEPTH: u32 = 12;

struct Reader {
    stream: Vec<u8>,
    at: usize,
}

impl Reader {
    fn next(&mut self) -> Option<u8> {
        let v = *self.stream.get(self.at)?;
        self.at += 1;
        Some(v)
    }

    fn node(&mut self, v: [P; 3], depth: u32, out: &mut Vec<([P; 3], u8)>) -> Option<()> {
        let code = self.next()?;
        let splits = code & 3;
        let special = usize::from(code >> 2);
        if splits == 0 {
            let state = if special == 3 {
                self.next()?.checked_add(3)?
            } else {
                code >> 2
            };
            out.push((v, state));
            return Some(());
        }
        if depth >= MAX_DEPTH || special > 2 {
            return None;
        }
        let p = [
            *v.get(special)?,
            *v.get((special + 1) % 3)?,
            *v.get((special + 2) % 3)?,
        ];
        let (m_a, m_b, m_c) = (mid(p[0], p[1]), mid(p[2], p[0]), mid(p[1], p[2]));
        // Each child: its corners, then how far its own corner list is rotated.
        let kids: Vec<([P; 3], usize)> = match splits {
            1 => vec![([p[0], m_c, p[2]], 1), ([p[0], p[1], m_c], 0)],
            2 => vec![
                ([m_b, p[1], p[2]], 1),
                ([m_a, p[1], m_b], 0),
                ([p[0], m_a, m_b], 0),
            ],
            _ => vec![
                ([m_a, m_c, m_b], 0),
                ([m_b, m_c, p[2]], 1),
                ([m_a, p[1], m_c], 0),
                ([p[0], m_a, m_b], 0),
            ],
        };
        for (mut corners, rot) in kids {
            corners.rotate_left(rot);
            self.node(corners, depth + 1, out)?;
        }
        Some(())
    }
}

/// The painted pieces of triangle `tri` (mm) that `text` describes, unpainted pieces (state 0) left out.
/// A text that does not parse gives nothing.
#[must_use]
pub fn decode(text: &str, tri: [[f32; 3]; 3]) -> Vec<PaintFacet> {
    let Some(stream) = nibbles(text.trim()) else {
        return Vec::new();
    };
    let mut r = Reader { stream, at: 0 };
    let mut out = Vec::new();
    let corners = tri.map(|p| p.map(f64::from));
    if r.node(corners, 0, &mut out).is_none() {
        return Vec::new();
    }
    out.into_iter()
        .filter(|(_, s)| *s > 0)
        .map(|(v, state)| PaintFacet {
            v: v.map(|p| {
                #[allow(clippy::cast_possible_truncation, reason = "mesh coordinates are f32")]
                p.map(|c| c as f32)
            }),
            state,
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Color regions of a layer
// ---------------------------------------------------------------------------------------------

use crate::geom::SCALE;
use crate::layers::LayerPlan;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;
use std::collections::BTreeMap;

/// How far paint reaches in from a surface per layer of distance to a top or bottom surface, mm.
/// Under a top or bottom surface a painted region only goes `TAPER * (j - 1)` deep on the
/// `j`th layer from it (none on the surface layer itself), so color does not show through the
/// shell; measured on `OrcaSlicer` (0.8 mm per layer at 0.2 mm layers).
const TAPER: f64 = 0.8;
const LEAD: f64 = 0.8;
/// Paint regions lose tips thinner than twice this, mm.
const TIP_CUT: f64 = 0.1;
/// A facet whose normal is this close to vertical is a top or bottom face rather than a wall.
const FLAT: f64 = 0.99;
/// Cell size of the distance grid, mm, and the most cells one layer may use.
const CELL: f64 = 0.1;
const MAX_CELLS: f64 = 4.0e6;

/// One edge of the distance grid: its cell and whether it runs along x.
type EdgeId = (usize, usize, bool);
/// A wall segment in mm.
type Seg = ((f64, f64), (f64, f64));
/// Painted pieces of a part in mm, with the filament each carries.
pub(crate) type Facets = Vec<([[f64; 3]; 3], u8)>;

/// What a part needs to split its outline on one layer.
pub(crate) struct LayerPaint<'a> {
    pub(crate) default_slot: u8,
    /// The part's outline on this layer.
    pub(crate) shapes: &'a Shapes,
    pub(crate) layer: u32,
    /// The cutting plane of the layer, mm.
    pub(crate) z: f64,
    pub(crate) plan: &'a LayerPlan,
    /// Outlines of the layers above and below (one entry per shell layer, empty where there is no layer).
    pub(crate) above: &'a [Shapes],
    pub(crate) below: &'a [Shapes],
    pub(crate) facets: &'a Facets,
}

/// Islands and holes of a painted layer's regions smaller than this, square units (0.01 mm2), are specks the
/// booleans leave where colors meet; no nozzle prints them.
pub(crate) const SPECK: u64 = 1_000_000;

/// How a part's loops become areas: contour resolution, slicing mode and closing radius.
pub(crate) type CutKey = (i64, crate::perimeters::Slicing, i32);
/// The outlines of painted parts by part and layer, each cut once: the color regions of a layer read the
/// outlines of the shell layers around it.
#[derive(Default)]
pub(crate) struct Cache {
    /// Keyed by the layer, the part beside the contour resolution, and the closing radius beside the slicing mode:
    /// the key and value types of the shell rule's memos, so the browser module carries one copy of the map.
    outlines: crate::par::Memo<(i64, i64, i32), std::sync::Arc<Shapes>>,
}

impl Clone for Cache {
    /// A copy starts empty: the entries belong to the session they were worked out for.
    fn clone(&self) -> Self {
        Self::default()
    }
}

impl std::fmt::Debug for Cache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("paint::Cache")
    }
}

impl Cache {
    /// The outline of part `part` on `layer`, cut as `cut` says.
    pub(crate) fn outline(
        &self,
        part: usize,
        layer: u32,
        cut: CutKey,
        work: impl FnOnce() -> Shapes,
    ) -> std::sync::Arc<Shapes> {
        let (resolution, slicing, closing) = cut;
        let part = i64::try_from(part).unwrap_or(i64::MAX);
        let key = (
            i64::from(layer),
            (resolution << 24) | part,
            closing.saturating_mul(4).saturating_add(slicing as i32),
        );
        self.outlines.get_or(key, || std::sync::Arc::new(work()))
    }
}

struct Grid {
    x0: f64,
    y0: f64,
    nx: usize,
    ny: usize,
    r: f64,
}

impl Grid {
    fn new(b: [f64; 4]) -> Self {
        let (w, h) = (b[2] - b[0] + 0.4, b[3] - b[1] + 0.4);
        let r = CELL.max(((w * h) / MAX_CELLS).sqrt());
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "grid sizes are positive and small"
        )]
        let (nx, ny) = ((w / r).ceil() as usize + 1, (h / r).ceil() as usize + 1);
        Self {
            x0: b[0] - 0.2,
            y0: b[1] - 0.2,
            nx,
            ny,
            r,
        }
    }

    fn len(&self) -> usize {
        self.nx * self.ny
    }

    #[allow(clippy::cast_precision_loss, reason = "cell indexes are small")]
    fn center(&self, ix: usize, iy: usize) -> (f64, f64) {
        (self.x0 + ix as f64 * self.r, self.y0 + iy as f64 * self.r)
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "guarded by the range checks"
    )]
    fn cell(&self, x: f64, y: f64) -> Option<usize> {
        let (fx, fy) = (((x - self.x0) / self.r).round(), ((y - self.y0) / self.r).round());
        #[allow(clippy::cast_precision_loss, reason = "grid sizes are small")]
        let (w, h) = (self.nx as f64, self.ny as f64);
        if fx < 0.0 || fy < 0.0 || fx >= w || fy >= h {
            return None;
        }
        Some(fy as usize * self.nx + fx as usize)
    }
}

fn to_mm(p: IntPoint<i32>) -> (f64, f64) {
    (f64::from(p.x) / SCALE, f64::from(p.y) / SCALE)
}

/// Marks the cells a segment passes through.
fn stamp(g: &Grid, mask: &mut [bool], a: (f64, f64), b: (f64, f64)) {
    let len = (b.0 - a.0).m_hypot(b.1 - a.1);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a step count"
    )]
    let steps = (len / (g.r * 0.5)).ceil().max(1.0) as usize;
    for k in 0..=steps {
        #[allow(clippy::cast_precision_loss, reason = "a step count")]
        let t = k as f64 / steps as f64;
        if let Some(c) = g.cell(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
            && let Some(m) = mask.get_mut(c)
        {
            *m = true;
        }
    }
}

/// Cells whose center is inside `shapes` (even-odd within each shape).
#[allow(clippy::indexing_slicing, reason = "rows and columns stay inside the grid")]
fn fill(g: &Grid, shapes: &Shapes) -> Vec<bool> {
    let mut out = vec![false; g.len()];
    for shape in shapes {
        for iy in 0..g.ny {
            let y = g.center(0, iy).1;
            let mut xs: Vec<f64> = Vec::new();
            for ring in shape {
                let n = ring.len();
                for k in 0..n {
                    let (Some(&a), Some(&b)) = (ring.get(k), ring.get((k + 1) % n)) else {
                        continue;
                    };
                    let ((ax, ay), (bx, by)) = (to_mm(a), to_mm(b));
                    if (ay > y) != (by > y) {
                        xs.push(ax + (y - ay) / (by - ay) * (bx - ax));
                    }
                }
            }
            xs.sort_by(f64::total_cmp);
            for k in (0..xs.len().saturating_sub(1)).step_by(2) {
                let (Some(&lo), Some(&hi)) = (xs.get(k), xs.get(k + 1)) else {
                    continue;
                };
                for ix in 0..g.nx {
                    let x = g.center(ix, 0).0;
                    if x >= lo && x < hi {
                        out[iy * g.nx + ix] = true;
                    }
                }
            }
        }
    }
    out
}

/// Distance in mm from every cell to the nearest marked cell (a large number when none is marked).
#[allow(clippy::indexing_slicing, reason = "rows and columns stay inside the grid")]
fn distance(g: &Grid, mask: &[bool]) -> Vec<f32> {
    const INF: f32 = 1.0e12;
    let mut d: Vec<f32> = mask.iter().map(|&m| if m { 0.0 } else { INF }).collect();
    let (nx, ny) = (g.nx, g.ny);
    let mut line = vec![0.0f32; nx.max(ny)];
    let mut out = vec![0.0f32; nx.max(ny)];
    for ix in 0..nx {
        for iy in 0..ny {
            line[iy] = d[iy * nx + ix];
        }
        squared_1d(&line[..ny], &mut out[..ny]);
        for iy in 0..ny {
            d[iy * nx + ix] = out[iy];
        }
    }
    for iy in 0..ny {
        line[..nx].copy_from_slice(&d[iy * nx..iy * nx + nx]);
        squared_1d(&line[..nx], &mut out[..nx]);
        d[iy * nx..iy * nx + nx].copy_from_slice(&out[..nx]);
    }
    #[allow(clippy::cast_possible_truncation, reason = "distances are small")]
    let r = g.r as f32;
    for v in &mut d {
        *v = if *v >= INF { INF } else { v.sqrt() * r };
    }
    d
}

/// One pass of the squared distance transform (lower envelope of parabolas).
#[allow(
    clippy::indexing_slicing,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "indexes stay inside the row"
)]
fn squared_1d(f: &[f32], out: &mut [f32]) {
    const INF: f32 = 1.0e12;
    let n = f.len();
    let mut v = vec![0usize; n];
    let mut z = vec![0.0f32; n + 1];
    let mut k = 0usize;
    z[0] = -INF;
    z[1] = INF;
    for q in 1..n {
        loop {
            let p = v[k];
            let s = ((f[q] + (q * q) as f32) - (f[p] + (p * p) as f32)) / (2.0 * q as f32 - 2.0 * p as f32);
            if s <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            if s <= z[k] {
                v[0] = q;
                z[0] = -INF;
                z[1] = INF;
            } else {
                k += 1;
                v[k] = q;
                z[k] = s;
                z[k + 1] = INF;
            }
            break;
        }
    }
    k = 0;
    for (q, o) in out.iter_mut().enumerate() {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let d = q as f32 - v[k] as f32;
        *o = d * d + f[v[k]];
    }
}

/// The outline of `field >= 0` as closed loops in mm, counterclockwise around regions.
fn contour(g: &Grid, field: &[f32]) -> Vec<Vec<IntPoint<i32>>> {
    // The outermost ring of cells counts as outside, so every region closes inside the grid.
    let at = |ix: usize, iy: usize| {
        if ix == 0 || iy == 0 || ix + 1 >= g.nx || iy + 1 >= g.ny {
            return -1.0;
        }
        field.get(iy * g.nx + ix).copied().unwrap_or(-1.0)
    };
    // Points on grid edges, keyed by (ix, iy, horizontal); segments join two of them.
    let mut pts: BTreeMap<EdgeId, (f64, f64)> = BTreeMap::new();
    let mut link: BTreeMap<EdgeId, Vec<EdgeId>> = BTreeMap::new();
    let cross = |a: f32, b: f32| -> f64 { f64::from(a / (a - b)) };
    for iy in 0..g.ny.saturating_sub(1) {
        for ix in 0..g.nx.saturating_sub(1) {
            let c = [at(ix, iy), at(ix + 1, iy), at(ix + 1, iy + 1), at(ix, iy + 1)];
            let mask = usize::from(c[0] >= 0.0)
                | usize::from(c[1] >= 0.0) << 1
                | usize::from(c[2] >= 0.0) << 2
                | usize::from(c[3] >= 0.0) << 3;
            if mask == 0 || mask == 15 {
                continue;
            }
            // Edge ids: bottom (ix,iy,h), right (ix+1,iy,v), top (ix,iy+1,h), left (ix,iy,v).
            let bottom = (ix, iy, true);
            let right = (ix + 1, iy, false);
            let top = (ix, iy + 1, true);
            let left = (ix, iy, false);
            let mut edge = |id: EdgeId, a: (usize, usize, f32), b: (usize, usize, f32)| {
                let t = cross(a.2, b.2);
                let (pa, pb) = (g.center(a.0, a.1), g.center(b.0, b.1));
                pts.entry(id)
                    .or_insert((pa.0 + (pb.0 - pa.0) * t, pa.1 + (pb.1 - pa.1) * t));
            };
            edge(bottom, (ix, iy, c[0]), (ix + 1, iy, c[1]));
            edge(right, (ix + 1, iy, c[1]), (ix + 1, iy + 1, c[2]));
            edge(top, (ix, iy + 1, c[3]), (ix + 1, iy + 1, c[2]));
            edge(left, (ix, iy, c[0]), (ix, iy + 1, c[3]));
            let pairs: &[(EdgeId, EdgeId)] = match mask {
                1 | 14 => &[(left, bottom)],
                2 | 13 => &[(bottom, right)],
                3 | 12 => &[(left, right)],
                4 | 11 => &[(right, top)],
                6 | 9 => &[(bottom, top)],
                7 | 8 => &[(left, top)],
                5 => {
                    if (c[0] + c[1] + c[2] + c[3]) / 4.0 >= 0.0 {
                        &[(left, top), (bottom, right)]
                    } else {
                        &[(left, bottom), (right, top)]
                    }
                }
                _ => {
                    if (c[0] + c[1] + c[2] + c[3]) / 4.0 >= 0.0 {
                        &[(left, bottom), (right, top)]
                    } else {
                        &[(left, top), (bottom, right)]
                    }
                }
            };
            for &(a, b) in pairs {
                link.entry(a).or_default().push(b);
                link.entry(b).or_default().push(a);
            }
        }
    }
    // Follow the links into closed chains.
    let mut used: BTreeMap<EdgeId, bool> = BTreeMap::new();
    let mut loops: Vec<Vec<IntPoint<i32>>> = Vec::new();
    let keys: Vec<_> = link.keys().copied().collect();
    for start in keys {
        if used.contains_key(&start) {
            continue;
        }
        let mut chain = vec![start];
        used.insert(start, true);
        let mut cur = start;
        loop {
            let next = link
                .get(&cur)
                .and_then(|n| n.iter().copied().find(|k| !used.contains_key(k)));
            let Some(k) = next else { break };
            used.insert(k, true);
            chain.push(k);
            cur = k;
        }
        if chain.len() < 3 {
            continue;
        }
        let mm: Vec<(f64, f64)> = chain.iter().filter_map(|k| pts.get(k).copied()).collect();
        // Orient so the region is on the left: sample beside the first segment.
        let (a, b) = (
            mm.first().copied().unwrap_or_default(),
            mm.get(1).copied().unwrap_or_default(),
        );
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = dx.m_hypot(dy).max(1e-9);
        let probe = (
            f64::midpoint(a.0, b.0) - dy / len * g.r * 0.3,
            f64::midpoint(a.1, b.1) + dx / len * g.r * 0.3,
        );
        let inside = sample(g, field, probe) >= 0.0;
        let mut ring: Vec<IntPoint<i32>> = mm
            .iter()
            .map(|&(x, y)| {
                #[allow(clippy::cast_possible_truncation, reason = "a point inside the bed")]
                IntPoint::new((x * SCALE).round() as i32, (y * SCALE).round() as i32)
            })
            .collect();
        if !inside {
            ring.reverse();
        }
        loops.push(ring);
    }
    loops
}

/// The nearest cell's value (enough to tell which side of a boundary a point is on).
fn sample(g: &Grid, field: &[f32], p: (f64, f64)) -> f32 {
    g.cell(p.0, p.1)
        .and_then(|c| field.get(c).copied())
        .unwrap_or(-1.0)
}

fn loops_to_shapes(loops: &[Vec<IntPoint<i32>>]) -> Shapes {
    let polys: Vec<crate::geom::Polygon> = loops
        .iter()
        .map(|l| l.iter().map(|p| crate::geom::Point::new(p.x, p.y)).collect())
        .collect();
    perimeters::shapes_from_loops(&polys)
}

fn ring_edges(shapes: &Shapes) -> Vec<Seg> {
    let mut out = Vec::new();
    for shape in shapes {
        for ring in shape {
            let n = ring.len();
            for k in 0..n {
                if let (Some(&a), Some(&b)) = (ring.get(k), ring.get((k + 1) % n)) {
                    out.push((to_mm(a), to_mm(b)));
                }
            }
        }
    }
    out
}

/// The depth limit in mm under a top or bottom surface `j` layers away (the surface layer is 1).
fn depth_limit(j: usize) -> f64 {
    #[allow(clippy::cast_precision_loss, reason = "shell layer counts are small")]
    let jf = j as f64;
    if j <= 1 {
        // The surface layer itself shows no paint from the walls.
        return -1.0;
    }
    TAPER * jf - LEAD
}

impl LayerPaint<'_> {
    /// The layer's outline split by color: the part's own filament where nothing is painted, and
    /// each painted filament where paint reaches. Colors come from the walls (painted surfaces
    /// cut by the layer plane, reaching to the nearest wall of another color and, under a top
    /// or bottom surface, only as deep as the taper allows) and from painted top and bottom
    /// faces (their outline, drawn in a little more on each layer below or above).
    pub(crate) fn split(&self) -> Vec<(u8, Shapes)> {
        let d = self.default_slot;
        let whole = || vec![(d, self.shapes.clone())];
        if self.shapes.is_empty() || self.facets.is_empty() {
            return whole();
        }
        // Painted walls cut by the plane, and painted flat faces near this layer.
        let mut walls: BTreeMap<u8, Vec<Seg>> = BTreeMap::new();
        let mut flat: BTreeMap<u8, Shapes> = BTreeMap::new();
        let top_shell = self.above.len();
        let bottom_shell = self.below.len();
        let mut flat_tris: BTreeMap<(u8, usize), Vec<Vec<IntPoint<i32>>>> = BTreeMap::new();
        for (tri, state) in self.facets {
            let [a, b, c] = *tri;
            let n = [
                (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
                (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
                (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
            ];
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if len < 1e-12 {
                continue;
            }
            let nz = n[2] / len;
            if nz.abs() >= FLAT {
                // The layer of the face and how far this layer is from it.
                let zf = a[2];
                let first = self.plan.first_at_or_above(zf);
                let (surface, j, ok) = if nz > 0.0 {
                    let k = first.saturating_sub(1);
                    let l = self.layer as usize;
                    (k, k.wrapping_sub(l).wrapping_add(1), k >= l && k - l < top_shell)
                } else {
                    let l = self.layer as usize;
                    (
                        first,
                        l.wrapping_sub(first).wrapping_add(1),
                        l >= first && l - first < bottom_shell,
                    )
                };
                let _ = surface;
                if ok {
                    let ring: Vec<IntPoint<i32>> = [a, b, c]
                        .iter()
                        .map(|p| {
                            #[allow(clippy::cast_possible_truncation, reason = "a point inside the bed")]
                            IntPoint::new((p[0] * SCALE).round() as i32, (p[1] * SCALE).round() as i32)
                        })
                        .collect();
                    let mut ring = ring;
                    if crate::geom::area2_int(&ring) < 0 {
                        ring.reverse();
                    }
                    flat_tris.entry((*state, j)).or_default().push(ring);
                }
                continue;
            }
            // A wall: the piece of the triangle the plane cuts.
            let z = self.z;
            let pts = [a, b, c];
            let mut cuts: Vec<(f64, f64)> = Vec::new();
            for k in 0..3 {
                let (Some(&p), Some(&q)) = (pts.get(k), pts.get((k + 1) % 3)) else {
                    continue;
                };
                if (p[2] > z) != (q[2] > z) {
                    let t = (z - p[2]) / (q[2] - p[2]);
                    cuts.push((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t));
                }
            }
            if let [s, e] = cuts.as_slice() {
                walls.entry(*state).or_default().push((*s, *e));
            }
        }
        for ((state, j), tris) in flat_tris {
            let projected: Shapes =
                perimeters::union_all(&[&tris.iter().map(|r| vec![r.clone()]).collect::<Shapes>()]);
            #[allow(clippy::cast_precision_loss, reason = "shell layer counts are small")]
            let inset = TAPER * (j as f64 - 1.0);
            let inside = perimeters::intersection(&projected, self.shapes);
            let shrunk = if inset > 0.0 {
                perimeters::offset(&inside, -crate::geom::mm(inset))
            } else {
                inside
            };
            if !shrunk.is_empty() {
                let entry = flat.entry(state).or_default();
                *entry = perimeters::union_all(&[entry, &shrunk]);
            }
        }
        let mut colored: Vec<(u8, Shapes)> = Vec::new();
        if !walls.is_empty() {
            colored = self.voronoi(&walls, top_shell, bottom_shell);
        }
        // Merge in the flat faces.
        for (state, shapes) in flat {
            match colored.iter_mut().find(|(s, _)| *s == state) {
                Some((_, have)) => *have = perimeters::union_all(&[have, &shapes]),
                None => colored.push((state, shapes)),
            }
        }
        colored.retain(|(_, s)| !s.is_empty());
        if colored.is_empty() {
            return whole();
        }
        let mut rest = self.shapes.clone();
        // Two colors on the same ground: the higher filament wins, as for overlapping parts.
        crate::sorting::sort_by_key(&mut colored, |(s, _)| *s);
        let mut out: Vec<(u8, Shapes)> = Vec::new();
        for (state, shapes) in colored.into_iter().rev() {
            // Sharp tips where a boundary meets the outline are rounded off: the perimeter offsets
            // spike out of them otherwise.
            let tip = crate::geom::mm(TIP_CUT);
            let piece = perimeters::intersection(&shapes, &rest);
            let piece = perimeters::offset(&perimeters::offset(&piece, -tip), tip);
            let piece = perimeters::intersection(&piece, &rest);
            rest = perimeters::difference(&rest, &piece);
            if !piece.is_empty() {
                out.push((state, piece));
            }
        }
        if !rest.is_empty() {
            match out.iter_mut().find(|(s, _)| *s == d) {
                Some((_, have)) => *have = perimeters::union_all(&[have, &rest]),
                None => out.push((d, rest)),
            }
        }
        out
    }

    /// Regions painted on the walls: each cell of the layer takes the color of the nearest wall
    /// (painted or not), within the depth the shell allows.
    fn voronoi(
        &self,
        walls: &BTreeMap<u8, Vec<Seg>>,
        top_shell: usize,
        bottom_shell: usize,
    ) -> Vec<(u8, Shapes)> {
        let Some(b) = perimeters::bounds(self.shapes) else {
            return Vec::new();
        };
        let g = Grid::new([
            f64::from(b[0]) / SCALE,
            f64::from(b[1]) / SCALE,
            f64::from(b[2]) / SCALE,
            f64::from(b[3]) / SCALE,
        ]);
        // Sources: painted walls per color, and the rest of the outline for the part's own color.
        let mut sources: BTreeMap<u8, Vec<bool>> = BTreeMap::new();
        let mut painted = vec![false; g.len()];
        for (state, segs) in walls {
            let mask = sources.entry(*state).or_insert_with(|| vec![false; g.len()]);
            for &(a, e) in segs {
                stamp(&g, mask, a, e);
                stamp(&g, &mut painted, a, e);
            }
        }
        let near_painted = |x: f64, y: f64| -> bool {
            g.cell(x, y).is_some_and(|c| {
                let (cx, cy) = (c % g.nx, c / g.nx);
                (cy.saturating_sub(1)..=(cy + 1).min(g.ny - 1)).any(|yy| {
                    (cx.saturating_sub(1)..=(cx + 1).min(g.nx - 1))
                        .any(|xx| painted.get(yy * g.nx + xx).copied().unwrap_or(false))
                })
            })
        };
        let default_mask = sources
            .entry(self.default_slot)
            .or_insert_with(|| vec![false; g.len()]);
        for (a, e) in ring_edges(self.shapes) {
            let len = (e.0 - a.0).m_hypot(e.1 - a.1);
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a step count"
            )]
            let steps = (len / (g.r * 0.5)).ceil().max(1.0) as usize;
            for k in 0..=steps {
                #[allow(clippy::cast_precision_loss, reason = "a step count")]
                let t = k as f64 / steps as f64;
                let (x, y) = (a.0 + (e.0 - a.0) * t, a.1 + (e.1 - a.1) * t);
                if !near_painted(x, y)
                    && let Some(c) = g.cell(x, y)
                    && let Some(m) = default_mask.get_mut(c)
                {
                    *m = true;
                }
            }
        }
        // Depth limit under top and bottom surfaces.
        let n = g.len();
        let mut limit = vec![f32::INFINITY; n];
        let apply = |limit: &mut Vec<f32>, layers: &[Shapes]| {
            // Cells outside the outline count as exposed, so a region stops at the outline.
            let mut open = vec![true; n];
            for (i, above) in layers.iter().enumerate() {
                let here = fill(&g, above);
                #[allow(clippy::cast_possible_truncation, reason = "a depth in mm")]
                let dl = depth_limit(i + 1) as f32;
                for ((o, h), l) in open.iter_mut().zip(&here).zip(limit.iter_mut()) {
                    if *o && !*h {
                        *o = false;
                        *l = l.min(dl);
                    }
                }
            }
        };
        if top_shell > 0 {
            apply(&mut limit, self.above);
        }
        if bottom_shell > 0 {
            apply(&mut limit, self.below);
        }
        let dist: BTreeMap<u8, Vec<f32>> = sources
            .iter()
            .filter(|(_, m)| m.iter().any(|&x| x))
            .map(|(s, m)| (*s, distance(&g, m)))
            .collect();
        let mut out = Vec::new();
        for (&state, own) in &dist {
            if state == self.default_slot {
                continue;
            }
            let field: Vec<f32> = (0..n)
                .map(|c| {
                    let mine = own.get(c).copied().unwrap_or(f32::INFINITY);
                    let other = dist
                        .iter()
                        .filter(|(s, _)| **s != state)
                        .map(|(_, d)| d.get(c).copied().unwrap_or(f32::INFINITY))
                        .fold(f32::INFINITY, f32::min);
                    let closer = if other.is_finite() { other - mine } else { 1.0 };
                    let reach = limit.get(c).copied().unwrap_or(f32::INFINITY) - mine;
                    closer.min(if reach.is_finite() { reach } else { 1.0 })
                })
                .collect();
            let shapes = loops_to_shapes(&contour(&g, &field));
            if !shapes.is_empty() {
                out.push((state, shapes));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::float_cmp,
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "test points are small and exact"
    )]
    use super::*;

    const TRI: [[f32; 3]; 3] = [[0.0, 0.0, 0.0], [20.0, 0.0, 0.0], [20.0, 20.0, 0.0]];

    fn area(f: &PaintFacet) -> f32 {
        let [a, b, c] = f.v;
        ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() / 2.0
    }

    #[test]
    fn a_whole_triangle_and_the_extended_states() {
        assert_eq!(
            decode("4", TRI).iter().map(|f| f.state).collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(decode("8", TRI)[0].state, 2);
        assert_eq!(decode("0C", TRI)[0].state, 3);
        assert_eq!(decode("1C", TRI)[0].state, 4);
        assert_eq!(decode("2C", TRI)[0].state, 5);
        // Unpainted, and text that is not hex.
        assert!(decode("0", TRI).is_empty());
        assert!(decode("zz", TRI).is_empty());
        assert!(decode("", TRI).is_empty());
        // A split that runs out of codes gives nothing.
        assert!(decode("1", TRI).is_empty());
    }

    #[test]
    fn one_split_side_halves_the_triangle_as_orca_prints_it() {
        // Special corner 0 splits the side opposite it: children (p0, mid, p2) then (p0, p1, mid).
        let both = decode("481", TRI);
        assert_eq!(both.len(), 2);
        let first = both.iter().find(|f| f.state == 2).unwrap();
        // The child next to the special corner and the far corner: (0,0) (20,10) (20,20).
        assert!(first.v.iter().any(|p| p[0] == 20.0 && p[1] == 10.0));
        assert!(first.v.iter().any(|p| p[0] == 20.0 && p[1] == 20.0));
        assert!((area(first) - 100.0).abs() < 1e-3);
        // Special corner 1 splits the other side, so the same first child moves.
        let moved = decode("485", TRI);
        let first = moved.iter().find(|f| f.state == 2).unwrap();
        assert!(first.v.iter().any(|p| p[0] == 10.0 && p[1] == 10.0), "{first:?}");
    }

    #[test]
    fn three_split_sides_make_four_children_that_add_up() {
        // Center, then the corners; states 1 to 4.
        let all = decode("1C0C843", TRI);
        assert_eq!(all.len(), 4);
        let total: f32 = all.iter().map(area).sum();
        assert!((total - 200.0).abs() < 1e-3);
        // The center child is a quarter of the triangle.
        let center = all.iter().find(|f| f.state == 1).unwrap();
        assert!((area(center) - 50.0).abs() < 1e-3);
    }

    #[test]
    fn nested_splits_partition_the_triangle() {
        // Root splits one side, its first child splits again.
        let all = decode("1C0C811", TRI);
        assert_eq!(all.len(), 3);
        let total: f32 = all.iter().map(area).sum();
        assert!((total - 200.0).abs() < 1e-3, "{total}");
        // The second split runs from the middle of the first child's far side.
        let two = all.iter().find(|f| f.state == 2).unwrap();
        assert!(two.v.iter().any(|p| p[0] == 10.0 && p[1] == 10.0));
    }

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        let p = |x: f64, y: f64| IntPoint::new((x * SCALE) as i32, (y * SCALE) as i32);
        vec![vec![vec![p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]]]
    }

    fn area_mm2(shapes: &Shapes) -> f64 {
        shapes
            .iter()
            .flat_map(|s| s.iter().enumerate())
            .map(|(i, r)| {
                let a = crate::geom::area2_int(r) as f64 / 2.0 / SCALE / SCALE;
                if i == 0 { a.abs() } else { -a.abs() }
            })
            .sum()
    }

    fn contains(shapes: &Shapes, x: f64, y: f64) -> bool {
        let g = Grid::new([x - 1.0, y - 1.0, x + 1.0, y + 1.0]);
        let mask = fill(&g, shapes);
        g.cell(x, y).is_some_and(|c| mask[c])
    }

    /// A 20 mm square column with its right face painted: the paint fills the wedge nearest that face.
    #[test]
    fn a_painted_wall_takes_the_wedge_nearest_it() {
        let plan = LayerPlan::new(10.0, 0.2, 0.2);
        let outline = square(118.0, 118.0, 138.0, 138.0);
        let facets: Facets = vec![
            (
                [[138.0, 118.0, 0.0], [138.0, 138.0, 0.0], [138.0, 138.0, 10.0]],
                2,
            ),
            (
                [[138.0, 118.0, 0.0], [138.0, 138.0, 10.0], [138.0, 118.0, 10.0]],
                2,
            ),
        ];
        let above = vec![outline.clone(); 5];
        let below = vec![outline.clone(); 3];
        let ctx = LayerPaint {
            default_slot: 1,
            shapes: &outline,
            layer: 20,
            z: plan.slice_z[20],
            plan: &plan,
            above: &above,
            below: &below,
            facets: &facets,
        };
        let parts = ctx.split();
        let colored = parts.iter().find(|(s, _)| *s == 2).map(|(_, s)| s).unwrap();
        let plain = parts.iter().find(|(s, _)| *s == 1).map(|(_, s)| s).unwrap();
        // The wedge between the two diagonals from the face's corners: a quarter of the square.
        assert!((area_mm2(colored) - 100.0).abs() < 4.0, "{}", area_mm2(colored));
        assert!(contains(colored, 137.5, 128.0) && contains(colored, 137.5, 119.0));
        assert!(!contains(colored, 120.0, 128.0) && contains(plain, 120.0, 128.0));
        assert!((area_mm2(colored) + area_mm2(plain) - 400.0).abs() < 1.0);
        let b = perimeters::bounds(colored).unwrap();
        assert!(f64::from(b[2]) / SCALE <= 138.0 + 1e-3, "{b:?}");
        eprintln!("colored bounds {b:?}");
    }

    #[test]
    fn distances_and_outlines_of_a_grid_are_right() {
        let g = Grid::new([0.0, 0.0, 10.0, 10.0]);
        let mut mask = vec![false; g.len()];
        stamp(&g, &mut mask, (0.0, 5.0), (10.0, 5.0));
        let d = distance(&g, &mask);
        let at = |x: f64, y: f64| d[g.cell(x, y).unwrap()];
        assert!((at(5.0, 8.0) - 3.0).abs() < 0.15, "{}", at(5.0, 8.0));
        assert!((at(2.0, 1.0) - 4.0).abs() < 0.15, "{}", at(2.0, 1.0));
        // A field that is positive on the right half gives one loop around it.
        let field: Vec<f32> = (0..g.len())
            .map(|c| {
                let (x, _) = g.center(c % g.nx, c / g.nx);
                (x - 5.0) as f32
            })
            .collect();
        let loops = contour(&g, &field);
        assert_eq!(loops.len(), 1, "{}", loops.len());
        let shapes = loops_to_shapes(&loops);
        assert!(contains(&shapes, 8.0, 5.0) && !contains(&shapes, 2.0, 5.0));
    }
}
