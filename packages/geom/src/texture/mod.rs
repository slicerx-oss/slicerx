// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Color paint from a model's texture. The source (an OBJ with its MTL and images, or a 3MF with the materials
//! extension) says what each of its triangles shows: a texture with coordinates, a plain color, or nothing. Each
//! triangle of the parts on the plate finds its source triangle (the same part triangle for triangle, or else the
//! nearest source triangle), and its paint is built as the brush builds it: a whole-triangle leaf where the texture
//! keeps to one filament, split in four where it changes, down to a smallest edge. Colors go to filaments through
//! `color_slots`. The filament with the most area becomes the part's own and stays unpainted.
// corners and barycentric weights are fixed-size arrays indexed by 0, 1 and 2; triangle and part numbers come from
// the meshes they index
#![allow(clippy::indexing_slicing)]

pub mod image;
pub mod obj;

use crate::color_slots;
use crate::error::{Error, Result};
use crate::mesh::TriMesh;
use crate::paint_tree::{self, Node};
use crate::vec3::V3;
use image::{Image, Wrap};
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;

/// What a source triangle shows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Look {
    None,
    Color([u8; 3]),
    Texture {
        image: u32,
        uv: [[f64; 2]; 3],
        wrap: (Wrap, Wrap),
    },
}

/// A mesh of the source and what each of its triangles shows.
#[derive(Debug, Clone, Default)]
pub struct SourcePart {
    pub positions: Vec<V3>,
    pub triangles: Vec<[u32; 3]>,
    pub looks: Vec<Look>,
}

/// A textured model as read for painting.
#[derive(Default)]
pub struct TextureSource {
    pub parts: Vec<SourcePart>,
    pub images: Vec<Image>,
    pub image_names: Vec<String>,
    pub notes: Vec<String>,
}

impl TextureSource {
    /// Whether any triangle shows a texture or a color.
    #[must_use]
    pub fn has_looks(&self) -> bool {
        self.parts
            .iter()
            .any(|p| p.looks.iter().any(|l| *l != Look::None))
    }
}

/// How texture colors become filaments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    /// The nearest of the given filament colors.
    #[default]
    Nearest,
    /// As many colors as there are filaments, picked from the texture; they become the filaments' colors.
    Palette,
}

#[derive(Debug, Clone)]
pub struct Options {
    /// Filament colors, slot 1 first.
    pub filaments: Vec<[u8; 3]>,
    pub mode: Mode,
    /// Smallest leaf edge, in mm on the plate.
    pub min_edge_mm: f64,
    pub max_depth: u32,
    /// Most leaves for all parts together; past it the smallest edge doubles and the paint is built again. A painted
    /// triangle is at least one leaf, so the budget is never under the number of painted triangles.
    pub max_leaves: usize,
    /// Parts (by index) whose paint keeps every filament, the one with the most area too, for a caller that cannot
    /// give those parts a filament of their own.
    pub paint_every: Vec<usize>,
    /// Plate mm per unit of the part meshes (the object's scale).
    pub scale: f64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            filaments: Vec::new(),
            mode: Mode::Nearest,
            min_edge_mm: 0.4,
            max_depth: 8,
            max_leaves: 2_000_000,
            paint_every: Vec::new(),
            scale: 1.0,
        }
    }
}

/// One plate part's paint.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PartPaint {
    /// The filament with the most area, which the part prints in; `None` when no triangle has a look.
    pub slot: Option<u8>,
    /// `paint_color` texts by triangle, for the leaves not in `slot`.
    pub paint: BTreeMap<u32, String>,
}

/// How the plate's triangles found their source.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Matched {
    /// Triangles of a part that is a source part, moved.
    pub same: usize,
    /// Triangles that took the nearest source triangle.
    pub nearest: usize,
}

#[derive(Debug, Clone, Default)]
pub struct Painted {
    pub parts: Vec<PartPaint>,
    /// Area per slot in mm2 (index 0 is slot 1), over every part.
    pub area_mm2: Vec<f64>,
    /// The colors the slots took from the texture (palette mode), slot 1 first.
    pub palette: Vec<[u8; 3]>,
    pub leaves: usize,
    /// The smallest edge used, after any doubling.
    pub min_edge_mm: f64,
    pub matched: Matched,
    pub notes: Vec<String>,
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn corners(pos: &[V3], t: [u32; 3]) -> Option<[V3; 3]> {
    Some([
        *pos.get(t[0] as usize)?,
        *pos.get(t[1] as usize)?,
        *pos.get(t[2] as usize)?,
    ])
}

/// Barycentric coordinates of `p` projected onto the triangle's plane.
fn bary(p: V3, v: &[V3; 3]) -> [f64; 3] {
    let (e0, e1, ep) = (sub(v[1], v[0]), sub(v[2], v[0]), sub(p, v[0]));
    let (d00, d01, d11) = (dot(e0, e0), dot(e0, e1), dot(e1, e1));
    let (d20, d21) = (dot(ep, e0), dot(ep, e1));
    let den = d00 * d11 - d01 * d01;
    if den.abs() < 1e-30 {
        return [1.0 / 3.0; 3];
    }
    let b = (d11 * d20 - d01 * d21) / den;
    let c = (d00 * d21 - d01 * d20) / den;
    [1.0 - b - c, b, c]
}

/// The point of the triangle closest to `p`, by the region of the triangle's plane `p` projects into.
fn closest_on(p: V3, v: &[V3; 3]) -> V3 {
    let [a, b, c] = *v;
    let at = |s: f64, t: f64| [0, 1, 2].map(|k| a[k] + s * (b[k] - a[k]) + t * (c[k] - a[k]));
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = sub(p, b);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return at(d1 / (d1 - d3), 0.0);
    }
    let cp = sub(p, c);
    let (d5, d6) = (dot(ab, cp), dot(ac, cp));
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return at(0.0, d2 / (d2 - d6));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return [0, 1, 2].map(|k| b[k] + w * (c[k] - b[k]));
    }
    let den = va + vb + vc;
    if den.abs() < 1e-300 {
        // a triangle with no area: its nearest corner
        return v
            .iter()
            .copied()
            .min_by(|x, y| dot(sub(p, *x), sub(p, *x)).total_cmp(&dot(sub(p, *y), sub(p, *y))))
            .unwrap_or(a);
    }
    at(vb / den, vc / den)
}

fn uv_at(look: &Look, w: [f64; 3]) -> Option<[f64; 2]> {
    match look {
        Look::Texture { uv, .. } => Some([
            w[0] * uv[0][0] + w[1] * uv[1][0] + w[2] * uv[2][0],
            w[0] * uv[0][1] + w[1] * uv[1][1] + w[2] * uv[2][1],
        ]),
        _ => None,
    }
}

/// A part that is a source part moved as a whole: the same triangles, every position off by one offset.
fn same_part(m: &TriMesh, s: &SourcePart) -> bool {
    if m.triangles.len() != s.triangles.len()
        || m.positions.len() != s.positions.len()
        || m.triangles != s.triangles
    {
        return false;
    }
    let (Some(a), Some(b)) = (m.positions.first(), s.positions.first()) else {
        return false;
    };
    let d = sub(*a, *b);
    m.positions.iter().zip(&s.positions).all(|(p, q)| {
        let e = sub(sub(*p, *q), d);
        e.iter().all(|c| c.abs() <= 1e-3)
    })
}

/// Source triangles by the grid cells their boxes cover, for the nearest one to a point. Every triangle is in it,
/// the ones that show nothing too, so a plate triangle over one of those stays unpainted.
struct Grid {
    cell: f64,
    lo: V3,
    /// cells along each axis
    n: [i64; 3],
    map: FxHashMap<(i64, i64, i64), Vec<(u32, u32)>>,
    /// triangles over more cells than `BIG_CELLS`, checked for every point
    big: Vec<(u32, u32)>,
    /// two candidates this close to the same distance are as near as each other
    tol: f64,
}

/// The most cells a triangle is listed in; a bigger one goes in `Grid::big`.
const BIG_CELLS: i64 = 512;

type Best = Option<(f64, bool, (u32, u32))>;

impl Grid {
    fn key(&self, p: V3) -> (i64, i64, i64) {
        // cell numbers of a finite model, far inside i64
        #[allow(clippy::cast_possible_truncation)]
        let k = |i: usize| ((p[i] - self.lo[i]) / self.cell).floor() as i64;
        (k(0), k(1), k(2))
    }

    fn new(src: &TextureSource) -> Self {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        let mut n = 0usize;
        let mut edge = 0.0;
        for s in &src.parts {
            for &t in &s.triangles {
                let Some(v) = corners(&s.positions, t) else {
                    continue;
                };
                for p in v {
                    for k in 0..3 {
                        lo[k] = lo[k].min(p[k]);
                        hi[k] = hi[k].max(p[k]);
                    }
                }
                edge += len(v[0], v[1]);
                n += 1;
            }
        }
        if n == 0 {
            (lo, hi) = ([0.0; 3], [0.0; 3]);
        }
        let size = (0..3).map(|k| hi[k] - lo[k]).fold(0.0, f64::max);
        let cell = if n > 0 {
            (edge / n as f64).max(size / 256.0).max(1e-6)
        } else {
            1.0
        };
        let mut g = Self {
            cell,
            lo,
            n: [1; 3],
            map: FxHashMap::default(),
            big: Vec::new(),
            tol: (size * 1e-9).max(1e-12),
        };
        let top = g.key(hi);
        g.n = [top.0 + 1, top.1 + 1, top.2 + 1];
        for (pi, s) in src.parts.iter().enumerate() {
            for (i, &t) in s.triangles.iter().enumerate() {
                let Some(v) = corners(&s.positions, t) else {
                    continue;
                };
                let id = (
                    u32::try_from(pi).unwrap_or(u32::MAX),
                    u32::try_from(i).unwrap_or(u32::MAX),
                );
                let a = g.key([0, 1, 2].map(|k| v[0][k].min(v[1][k]).min(v[2][k])));
                let b = g.key([0, 1, 2].map(|k| v[0][k].max(v[1][k]).max(v[2][k])));
                let cells = (b.0 - a.0 + 1)
                    .saturating_mul(b.1 - a.1 + 1)
                    .saturating_mul(b.2 - a.2 + 1);
                if cells > BIG_CELLS {
                    g.big.push(id);
                    continue;
                }
                for x in a.0..=b.0 {
                    for y in a.1..=b.1 {
                        for z in a.2..=b.2 {
                            g.map.entry((x, y, z)).or_default().push(id);
                        }
                    }
                }
            }
        }
        g
    }

    fn consider(&self, src: &TextureSource, p: V3, normal: V3, (pi, ti): (u32, u32), best: &mut Best) {
        let Some(s) = src.parts.get(pi as usize) else {
            return;
        };
        let Some(v) = s
            .triangles
            .get(ti as usize)
            .and_then(|&t| corners(&s.positions, t))
        else {
            return;
        };
        let d = len(p, closest_on(p, &v));
        let facing = dot(cross(sub(v[1], v[0]), sub(v[2], v[0])), normal) > 0.0;
        let better = match *best {
            None => true,
            Some((bd, bf, _)) => d < bd - self.tol || (d <= bd + self.tol && facing && !bf),
        };
        if better {
            *best = Some((d, facing, (pi, ti)));
        }
    }

    /// The source triangle nearest `p`; of ones as near as each other, one facing about the same way as `normal`.
    /// A cell lists every triangle whose box covers it, so once the cells within `r` of `p`'s are read, a triangle not
    /// met yet is at least `r` cells away, and the search stops when the best is nearer than that.
    fn nearest(&self, src: &TextureSource, p: V3, normal: V3) -> Option<(u32, u32)> {
        let mut best: Best = None;
        for &id in &self.big {
            self.consider(src, p, normal, id, &mut best);
        }
        let c = self.key(p);
        let c = [c.0, c.1, c.2];
        // past this ring there are no cells
        let last = (0..3)
            .map(|k| c[k].abs().max((self.n[k] - 1 - c[k]).abs()))
            .max()
            .unwrap_or(0);
        // rings nearer than the grid's box hold no cells: a point far outside starts at the box
        let first = (0..3)
            .map(|k| (-c[k]).max(c[k] - (self.n[k] - 1)).max(0))
            .max()
            .unwrap_or(0);
        for r in first..=last {
            // only the ring's cells inside the grid, so a ring costs at most the grid's own cells
            for dx in (-r).max(-c[0])..=r.min(self.n[0] - 1 - c[0]) {
                let x = c[0] + dx;
                for dy in (-r).max(-c[1])..=r.min(self.n[1] - 1 - c[1]) {
                    let y = c[1] + dy;
                    // the ring's shell only: every z on its x and y faces, the two z faces inside them
                    let (mut dz, end, step) = if dx.abs() == r || dy.abs() == r {
                        ((-r).max(-c[2]), r.min(self.n[2] - 1 - c[2]), 1)
                    } else {
                        (-r, r, 2 * r)
                    };
                    while dz <= end {
                        if let Some(list) = self.map.get(&(x, y, c[2] + dz)) {
                            for &id in list {
                                self.consider(src, p, normal, id, &mut best);
                            }
                        }
                        dz += step;
                    }
                }
            }
            if let Some((bd, _, _)) = best
                && bd + self.tol <= r as f64 * self.cell
            {
                break;
            }
        }
        best.map(|b| b.2)
    }
}

/// The slots colors map to, through a cache on 5 bits a channel.
struct Slots {
    filaments: Vec<[u8; 3]>,
    cache: Vec<u8>,
}

impl Slots {
    fn new(filaments: Vec<[u8; 3]>) -> Self {
        Self {
            filaments,
            cache: vec![u8::MAX; 1 << 15],
        }
    }

    fn of(&mut self, c: [u8; 3]) -> u8 {
        let k = (usize::from(c[0] >> 3) << 10) | (usize::from(c[1] >> 3) << 5) | usize::from(c[2] >> 3);
        match self.cache.get(k).copied() {
            Some(s) if s != u8::MAX => s,
            _ => {
                let center = [(c[0] & 0xF8) | 4, (c[1] & 0xF8) | 4, (c[2] & 0xF8) | 4];
                let s = color_slots::nearest_slots(&[center], &self.filaments)
                    .first()
                    .copied()
                    .unwrap_or(0);
                if let Some(slot) = self.cache.get_mut(k) {
                    *slot = s;
                }
                s
            }
        }
    }
}

struct Builder<'a> {
    src: &'a TextureSource,
    min_edge: f64,
    max_depth: u32,
    scale: f64,
    leaves: usize,
    max_leaves: usize,
}

/// What the builder samples at a point: a color, or nothing.
type Sampler<'b> = dyn FnMut([u8; 3]) -> u8 + 'b;

fn len(a: V3, b: V3) -> f64 {
    dot(sub(a, b), sub(a, b)).sqrt()
}

fn area(v: &[V3; 3]) -> f64 {
    let c = cross(sub(v[1], v[0]), sub(v[2], v[0]));
    0.5 * dot(c, c).sqrt()
}

struct OverBudget;

impl Builder<'_> {
    fn color_at(&self, look: &Look, w: [f64; 3], texels: f64) -> Option<[u8; 3]> {
        match look {
            Look::None => None,
            Look::Color(c) => Some(*c),
            Look::Texture { image, wrap, .. } => {
                let uv = uv_at(look, w)?;
                self.src.images.get(*image as usize)?.sample(uv, texels, *wrap)
            }
        }
    }

    /// The tree for one plate triangle. `p` are its corners (plate units), `w` their barycentric coordinates in the
    /// source triangle. Leaf areas add into `area` (mm2, by state).
    #[allow(
        clippy::too_many_arguments,
        reason = "the recursion carries its triangle in both spaces"
    )]
    fn node(
        &mut self,
        look: &Look,
        p: [V3; 3],
        w: [[f64; 3]; 3],
        depth: u32,
        slot: &mut Sampler<'_>,
        area_by: &mut Vec<f64>,
    ) -> std::result::Result<Node, OverBudget> {
        let edge = len(p[0], p[1]).max(len(p[1], p[2])).max(len(p[2], p[0])) * self.scale;
        let (texels, uv_texels) = match look {
            Look::Texture { image, .. } => {
                let (iw, ih) = self.src.images.get(*image as usize).map_or((1, 1), Image::size);
                let uv = [uv_at(look, w[0]), uv_at(look, w[1]), uv_at(look, w[2])];
                match uv {
                    [Some(a), Some(b), Some(c)] => {
                        let a2 = ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs()
                            * iw as f64
                            * ih as f64;
                        let side = a2.sqrt();
                        (side, side)
                    }
                    _ => (0.0, 0.0),
                }
            }
            _ => (0.0, 0.0),
        };
        let mid = [0, 1, 2].map(|k| (w[0][k] + w[1][k] + w[2][k]) / 3.0);
        let at = |t: f64, c: [f64; 3]| [0, 1, 2].map(|k| c[k] + (mid[k] - c[k]) * t);
        let sample = |b: &Builder<'_>, ww: [f64; 3], slot: &mut Sampler<'_>| -> u8 {
            b.color_at(look, ww, texels).map_or(0, &mut *slot)
        };
        let center = sample(self, mid, slot);
        let can_split =
            depth < self.max_depth && edge > self.min_edge && !matches!(look, Look::Color(_) | Look::None);
        let split = can_split && {
            let differs = (0..3).any(|k| sample(self, at(0.1, w[k]), slot) != center);
            // a big triangle over many texels may hide a small feature its corners miss
            differs || (edge > 4.0 * self.min_edge && uv_texels > 1.0)
        };
        if !split {
            self.leaves += 1;
            if self.leaves > self.max_leaves {
                return Err(OverBudget);
            }
            let s = usize::from(center);
            if area_by.len() <= s {
                area_by.resize(s + 1, 0.0);
            }
            if let Some(a) = area_by.get_mut(s) {
                *a += area(&p) * self.scale * self.scale;
            }
            return Ok(Node::Leaf(center));
        }
        let kids_p = paint_tree::split_corners(p, 3, 0).ok_or(OverBudget)?;
        let kids_w = paint_tree::split_corners(w, 3, 0).ok_or(OverBudget)?;
        let mut kids = Vec::with_capacity(4);
        for (kp, kw) in kids_p.into_iter().zip(kids_w) {
            kids.push(self.node(look, kp, kw, depth + 1, slot, area_by)?);
        }
        Ok(Node::Split {
            splits: 3,
            special: 0,
            kids,
        })
    }
}

fn replace_state(n: Node, from: u8) -> Node {
    match n {
        Node::Leaf(s) if s == from => Node::Leaf(0),
        Node::Leaf(_) => n,
        Node::Split {
            splits,
            special,
            kids,
        } => Node::Split {
            splits,
            special,
            kids: kids.into_iter().map(|k| replace_state(k, from)).collect(),
        },
    }
}

/// The source triangle and corner weights of every plate triangle, per part.
type Placement = Vec<Vec<Option<(Look, [[f64; 3]; 3])>>>;

fn place(src: &TextureSource, parts: &[TriMesh]) -> (Placement, Matched) {
    let mut matched = Matched::default();
    let mut grid: Option<Grid> = None;
    let mut out = Vec::with_capacity(parts.len());
    let id = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for m in parts {
        if let Some(s) = src.parts.iter().find(|s| same_part(m, s)) {
            matched.same += m.triangles.len();
            out.push(
                s.looks
                    .iter()
                    .map(|l| (*l != Look::None).then_some((*l, id)))
                    .collect(),
            );
            continue;
        }
        let g = grid.get_or_insert_with(|| Grid::new(src));
        let mut row = Vec::with_capacity(m.triangles.len());
        for &t in &m.triangles {
            let Some(v) = corners(&m.positions, t) else {
                row.push(None);
                continue;
            };
            let c = [0, 1, 2].map(|k| (v[0][k] + v[1][k] + v[2][k]) / 3.0);
            let n = cross(sub(v[1], v[0]), sub(v[2], v[0]));
            let hit = g.nearest(src, c, n).and_then(|(pi, ti)| {
                let s = src.parts.get(pi as usize)?;
                let sv = s
                    .triangles
                    .get(ti as usize)
                    .and_then(|&st| corners(&s.positions, st))?;
                let look = s.looks.get(ti as usize).copied().unwrap_or(Look::None);
                Some((look, [bary(v[0], &sv), bary(v[1], &sv), bary(v[2], &sv)]))
            });
            if hit.is_some() {
                matched.nearest += 1;
            }
            // a source triangle that shows nothing leaves this one unpainted
            row.push(hit.filter(|(l, _)| *l != Look::None));
        }
        out.push(row);
    }
    (out, matched)
}

/// Colors sampled over the plate parts, weighted by area, for picking a palette: texels themselves (not averages of
/// several, which would pull the palette to in-between colors), on a grid of points about four smallest edges apart.
fn sampled_colors(
    src: &TextureSource,
    parts: &[TriMesh],
    placed: &Placement,
    opts: &Options,
) -> Vec<([u8; 3], f64)> {
    let b = Builder {
        src,
        min_edge: opts.min_edge_mm,
        max_depth: 0,
        scale: opts.scale,
        leaves: 0,
        max_leaves: usize::MAX,
    };
    let step = (opts.min_edge_mm * 4.0).max(0.05);
    let mut buckets: FxHashMap<u16, ([f64; 3], f64)> = FxHashMap::default();
    for (m, row) in parts.iter().zip(placed) {
        for (&t, hit) in m.triangles.iter().zip(row) {
            let (Some((look, w)), Some(v)) = (hit, corners(&m.positions, t)) else {
                continue;
            };
            let edge = len(v[0], v[1]).max(len(v[1], v[2])).max(len(v[2], v[0])) * opts.scale;
            // a count of grid rows, 1 to 16
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let n = ((edge / step).ceil() as usize).clamp(1, 16);
            let each = area(&v) * opts.scale * opts.scale / (n * n) as f64;
            for i in 0..n {
                for j in 0..n - i {
                    // the centroid of each small triangle of the grid that points the same way as the triangle
                    let (a, c) = (
                        (i as f64 + 1.0 / 3.0) / n as f64,
                        (j as f64 + 1.0 / 3.0) / n as f64,
                    );
                    let bw = [1.0 - a - c, a, c];
                    let ww = [0, 1, 2].map(|k| bw[0] * w[0][k] + bw[1] * w[1][k] + bw[2] * w[2][k]);
                    let Some(col) = b.color_at(look, ww, 0.0) else {
                        continue;
                    };
                    let k = (u16::from(col[0] >> 3) << 10)
                        | (u16::from(col[1] >> 3) << 5)
                        | u16::from(col[2] >> 3);
                    let e = buckets.entry(k).or_insert(([0.0; 3], 0.0));
                    for (sum, ch) in e.0.iter_mut().zip(col) {
                        *sum += f64::from(ch) * each;
                    }
                    e.1 += each;
                }
            }
        }
    }
    let mut out: Vec<([u8; 3], f64)> = buckets
        .into_values()
        .filter(|(_, w)| *w > 0.0)
        .map(|(s, w)| {
            // means of 0 to 255 values
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let c = s.map(|x| (x / w).round().clamp(0.0, 255.0) as u8);
            (c, w)
        })
        .collect();
    out.sort_by_key(|c| c.0);
    out
}

/// Paints `parts` (meshes in the source's coordinates, moved or repaired) from `src`.
#[allow(
    clippy::too_many_lines,
    reason = "the paint, its retry at a coarser edge and the part filaments read best together"
)]
pub fn paint(src: &TextureSource, parts: &[TriMesh], opts: &Options) -> Result<Painted> {
    if opts.filaments.is_empty() {
        return Err(Error::invalid("filaments", "needs at least one filament color"));
    }
    let (placed, matched) = place(src, parts);
    let mut notes = src.notes.clone();
    let filaments = match opts.mode {
        Mode::Nearest => opts.filaments.clone(),
        Mode::Palette => {
            let colors = sampled_colors(src, parts, &placed, opts);
            let mut p = color_slots::palette(&colors, opts.filaments.len());
            if p.is_empty() {
                p.clone_from(&opts.filaments);
            }
            p
        }
    };
    let first_edge = opts.min_edge_mm.max(0.01);
    let mut min_edge = first_edge;
    // with every triangle one leaf the paint is as coarse as it gets, so that many leaves always fit
    let painted = placed.iter().flatten().filter(|h| h.is_some()).count();
    let max_leaves = opts.max_leaves.max(painted);
    loop {
        let mut slots = Slots::new(filaments.clone());
        let mut b = Builder {
            src,
            min_edge,
            max_depth: opts.max_depth.min(paint_tree::MAX_DEPTH - 1),
            scale: opts.scale.max(1e-9),
            leaves: 0,
            max_leaves,
        };
        let mut trees: Vec<Vec<Option<Node>>> = Vec::with_capacity(parts.len());
        let mut part_areas: Vec<Vec<f64>> = Vec::with_capacity(parts.len());
        let mut over = false;
        'parts: for (m, row) in parts.iter().zip(&placed) {
            let mut nodes = Vec::with_capacity(m.triangles.len());
            let mut areas = Vec::new();
            for (&t, hit) in m.triangles.iter().zip(row) {
                let (Some((look, w)), Some(v)) = (hit, corners(&m.positions, t)) else {
                    nodes.push(None);
                    continue;
                };
                let mut f = |c: [u8; 3]| slots.of(c);
                let Ok(n) = b.node(look, v, *w, 0, &mut f, &mut areas) else {
                    over = true;
                    break 'parts;
                };
                nodes.push(Some(paint_tree::simplify(n)));
            }
            trees.push(nodes);
            part_areas.push(areas);
        }
        if over {
            if !min_edge.is_finite() {
                return Err(Error::invalid(
                    "maxLeaves",
                    "the paint does not fit in any number of leaves",
                ));
            }
            min_edge *= 2.0;
            continue;
        }
        if min_edge > first_edge {
            notes.push(format!(
                "The texture is finer than this model's paint can hold, so it is painted at {min_edge:.1} mm."
            ));
        }
        let mut out = Painted {
            palette: if opts.mode == Mode::Palette {
                filaments.clone()
            } else {
                Vec::new()
            },
            leaves: b.leaves,
            min_edge_mm: min_edge,
            matched,
            notes,
            ..Painted::default()
        };
        out.area_mm2 = vec![0.0; filaments.len()];
        for (pi, (nodes, areas)) in trees.into_iter().zip(part_areas).enumerate() {
            for (s, a) in areas.iter().enumerate().skip(1) {
                if let Some(t) = out.area_mm2.get_mut(s - 1) {
                    *t += a;
                }
            }
            let dominant = areas
                .iter()
                .enumerate()
                .skip(1)
                .filter(|(_, a)| **a > 0.0)
                .max_by(|a, b| a.1.total_cmp(b.1).then(b.0.cmp(&a.0)))
                .and_then(|(s, _)| u8::try_from(s).ok());
            let mut pp = PartPaint {
                slot: dominant,
                paint: BTreeMap::new(),
            };
            if let Some(d) = dominant {
                for (i, n) in nodes.into_iter().enumerate() {
                    let Some(n) = n else { continue };
                    let n = if opts.paint_every.contains(&pi) {
                        n
                    } else {
                        paint_tree::simplify(replace_state(n, d))
                    };
                    if n != Node::Leaf(0) {
                        pp.paint
                            .insert(u32::try_from(i).unwrap_or(u32::MAX), paint_tree::encode(&n));
                    }
                }
            }
            out.parts.push(pp);
        }
        return Ok(out);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn crc32(data: &[u8]) -> u32 {
        let mut c = 0xFFFF_FFFFu32;
        for &b in data {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    (c >> 1) ^ 0xEDB8_8320
                } else {
                    c >> 1
                };
            }
        }
        !c
    }

    /// A PNG of `w` x `h` RGB pixels, rows from the top.
    pub(crate) fn png_rgb(w: usize, h: usize, rgb: &[u8]) -> Vec<u8> {
        let mut raw = Vec::with_capacity((w * 3 + 1) * h);
        for y in 0..h {
            raw.push(0);
            raw.extend_from_slice(&rgb[y * w * 3..(y + 1) * w * 3]);
        }
        let mut out = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10];
        let mut chunk = |kind: &[u8; 4], data: &[u8]| {
            out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
            let mut body = kind.to_vec();
            body.extend_from_slice(data);
            out.extend_from_slice(&body);
            out.extend_from_slice(&crc32(&body).to_be_bytes());
        };
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&u32::try_from(w).unwrap().to_be_bytes());
        ihdr.extend_from_slice(&u32::try_from(h).unwrap().to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        chunk(b"IHDR", &ihdr);
        chunk(b"IDAT", &miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6));
        chunk(b"IEND", &[]);
        out
    }

    const RED: [u8; 3] = [230, 20, 30];
    const GREEN: [u8; 3] = [20, 200, 40];
    const BLUE: [u8; 3] = [20, 40, 220];
    const WHITE: [u8; 3] = [245, 245, 245];

    /// Four quadrants: red top left, green top right, blue bottom left, white bottom right.
    fn quadrants(n: usize) -> Image {
        let mut px = Vec::with_capacity(n * n);
        for y in 0..n {
            for x in 0..n {
                let c = match (x < n / 2, y < n / 2) {
                    (true, true) => RED,
                    (false, true) => GREEN,
                    (true, false) => BLUE,
                    (false, false) => WHITE,
                };
                px.push([c[0], c[1], c[2], 255]);
            }
        }
        Image::from_rgba(n, n, px).unwrap()
    }

    /// A 20 mm square in z = 0 made of two triangles, uv 0 to 1 across it.
    fn square_source() -> TextureSource {
        let positions = vec![
            [0.0, 0.0, 0.0],
            [20.0, 0.0, 0.0],
            [20.0, 20.0, 0.0],
            [0.0, 20.0, 0.0],
        ];
        let uv = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let tris = [[0u32, 1, 2], [0, 2, 3]];
        let looks = tris
            .iter()
            .map(|t| Look::Texture {
                image: 0,
                uv: t.map(|i| uv[i as usize]),
                wrap: (Wrap::Repeat, Wrap::Repeat),
            })
            .collect();
        TextureSource {
            parts: vec![SourcePart {
                positions,
                triangles: tris.to_vec(),
                looks,
            }],
            images: vec![quadrants(16)],
            image_names: vec!["q.png".into()],
            notes: Vec::new(),
        }
    }

    fn mesh_of(s: &SourcePart) -> TriMesh {
        let mut m = TriMesh::default();
        for p in &s.positions {
            m.push_vertex(*p);
        }
        m.triangles.clone_from(&s.triangles);
        m
    }

    fn opts() -> Options {
        Options {
            filaments: vec![WHITE, RED, GREEN, BLUE],
            min_edge_mm: 0.5,
            ..Options::default()
        }
    }

    fn area_of(p: &Painted, slot: usize) -> f64 {
        p.area_mm2.get(slot - 1).copied().unwrap_or(0.0)
    }

    #[test]
    fn quadrants_paint_a_quarter_each_and_the_largest_stays_unpainted() {
        let src = square_source();
        let got = paint(&src, &[mesh_of(&src.parts[0])], &opts()).unwrap();
        for slot in 1..=4 {
            assert!(
                (area_of(&got, slot) - 100.0).abs() < 2.0,
                "slot {slot}: {:?}",
                got.area_mm2
            );
        }
        assert_eq!(got.matched.same, 2);
        let part = &got.parts[0];
        // a tie goes to the lowest slot, which prints unpainted
        assert_eq!(part.slot, Some(1));
        assert_eq!(part.paint.len(), 2);
        // read back, the leaves cover every other slot's quarter
        let m = mesh_of(&src.parts[0]);
        let texts: BTreeMap<u32, String> = part.paint.clone();
        let (states, bad) = crate::paint_ops::regions(&m, &texts);
        assert_eq!(bad, 0);
        for s in &states {
            assert!(
                (s.area_mm2 - 100.0).abs() < 2.0,
                "state {}: {}",
                s.state,
                s.area_mm2
            );
        }
        assert_eq!(states.iter().map(|s| s.state).collect::<Vec<_>>(), vec![2, 3, 4]);
    }

    #[test]
    fn splitting_stops_at_the_smallest_edge() {
        let src = square_source();
        let coarse = paint(
            &src,
            &[mesh_of(&src.parts[0])],
            &Options {
                min_edge_mm: 5.0,
                ..opts()
            },
        )
        .unwrap();
        let fine = paint(
            &src,
            &[mesh_of(&src.parts[0])],
            &Options {
                min_edge_mm: 0.5,
                ..opts()
            },
        )
        .unwrap();
        assert!(coarse.leaves < fine.leaves, "{} {}", coarse.leaves, fine.leaves);
        // the quadrant edges run along the split lines, so even coarse leaves land on them
        for slot in 1..=4 {
            assert!((area_of(&coarse, slot) - 100.0).abs() < 2.0);
        }
    }

    #[test]
    fn a_one_color_triangle_is_one_leaf_and_unpainted() {
        let mut src = square_source();
        src.images = vec![Image::from_rgba(1, 1, vec![[RED[0], RED[1], RED[2], 255]]).unwrap()];
        let got = paint(&src, &[mesh_of(&src.parts[0])], &opts()).unwrap();
        assert_eq!(got.leaves, 2);
        assert_eq!(got.parts[0].slot, Some(2));
        assert!(got.parts[0].paint.is_empty());
    }

    #[test]
    fn over_the_leaf_cap_the_smallest_edge_doubles() {
        let mut src = square_source();
        // a fine checkerboard: every leaf differs from its corners down to the smallest edge
        let mut px = Vec::new();
        for y in 0..64 {
            for x in 0..64 {
                px.push(if (x + y) % 2 == 0 {
                    [RED[0], RED[1], RED[2], 255]
                } else {
                    [BLUE[0], BLUE[1], BLUE[2], 255]
                });
            }
        }
        src.images = vec![Image::from_rgba(64, 64, px).unwrap()];
        let got = paint(
            &src,
            &[mesh_of(&src.parts[0])],
            &Options {
                min_edge_mm: 0.05,
                max_leaves: 400,
                ..opts()
            },
        )
        .unwrap();
        assert!(got.leaves <= 400);
        assert!(got.min_edge_mm > 0.05);
        assert!(got.notes.iter().any(|n| n.contains("finer")));
    }

    #[test]
    fn a_moved_part_and_a_repaired_one_find_their_source() {
        let src = square_source();
        // moved by (5, -3, 1): the same triangles
        let mut moved = mesh_of(&src.parts[0]);
        moved.map_positions(|p| [p[0] + 5.0, p[1] - 3.0, p[2] + 1.0]);
        let a = paint(&src, &[moved], &opts()).unwrap();
        assert_eq!(a.matched.same, 2);
        // repaired: welded and reordered into four triangles about the center
        let mut m = TriMesh::default();
        for p in [
            [0.0, 0.0, 0.0],
            [20.0, 0.0, 0.0],
            [20.0, 20.0, 0.0],
            [0.0, 20.0, 0.0],
            [10.0, 10.0, 0.0],
        ] {
            m.push_vertex(p);
        }
        m.triangles = vec![[1, 2, 4], [0, 1, 4], [3, 0, 4], [2, 3, 4]];
        let b = paint(&src, &[m], &opts()).unwrap();
        assert_eq!(b.matched.nearest, 4);
        for slot in 1..=4 {
            assert!(
                (area_of(&b, slot) - 100.0).abs() < 2.0,
                "slot {slot}: {:?}",
                b.area_mm2
            );
        }
    }

    #[test]
    fn palette_mode_picks_the_texture_colors() {
        let src = square_source();
        let got = paint(
            &src,
            &[mesh_of(&src.parts[0])],
            &Options {
                filaments: vec![[0, 0, 0]; 4],
                mode: Mode::Palette,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(got.palette.len(), 4);
        for c in [RED, GREEN, BLUE, WHITE] {
            assert!(
                got.palette
                    .iter()
                    .any(|p| color_slots::delta_e(color_slots::lab(*p), color_slots::lab(c)) < 3.0),
                "{c:?} in {:?}",
                got.palette
            );
        }
        for slot in 1..=4 {
            assert!((area_of(&got, slot) - 100.0).abs() < 2.0);
        }
    }

    #[test]
    fn no_filament_is_refused_and_untextured_triangles_stay_unpainted() {
        let src = square_source();
        assert!(
            paint(
                &src,
                &[mesh_of(&src.parts[0])],
                &Options {
                    filaments: vec![],
                    ..opts()
                }
            )
            .is_err()
        );
        let mut plain = src;
        plain.parts[0].looks = vec![Look::None, Look::Color(BLUE)];
        let got = paint(&plain, &[mesh_of(&plain.parts[0])], &opts()).unwrap();
        assert_eq!(got.parts[0].slot, Some(4));
        assert!(got.parts[0].paint.is_empty());
    }

    #[test]
    fn more_triangles_than_the_leaf_cap_still_paint_one_leaf_each() {
        let src = square_source();
        let got = paint(
            &src,
            &[mesh_of(&src.parts[0])],
            &Options {
                max_leaves: 1,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(got.leaves, 2);
        let said: Vec<_> = got.notes.iter().filter(|n| n.contains("finer")).collect();
        assert_eq!(said.len(), 1, "{:?}", got.notes);
        assert!(
            said[0].contains(&format!("{:.1} mm", got.min_edge_mm)),
            "{said:?}"
        );
    }

    #[test]
    fn a_triangle_far_outside_the_source_is_found_without_scanning_the_empty_rings() {
        // one 5 mm triangle 1000 km off a 20 mm source square. The cells are about 24 mm (the mean of the triangles'
        // first edges, 20 and 28.3 mm), so the point is about 4.1e7 rings out. Reading each ring's every x and y, inside
        // the grid or not, took about 4r steps a ring: some 3e15 for one lookup.
        let src = square_source();
        let mut far = TriMesh::default();
        for p in [[1e9, 1e9, 0.0], [1e9 + 5.0, 1e9, 0.0], [1e9, 1e9 + 5.0, 0.0]] {
            far.push_vertex(p);
        }
        far.triangles.push([0, 1, 2]);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let got = paint(&src, &[far], &opts()).map(|p| p.matched);
            let _ = tx.send(got);
        });
        let got = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the nearest search took over 10 s")
            .unwrap();
        assert_eq!(got.nearest, 1);
    }

    /// Two 20 mm squares in z = 0 at x 0 and x 100: the first shows nothing, the second is red.
    fn body_and_label() -> TextureSource {
        let mut positions = Vec::new();
        let mut triangles = Vec::new();
        for x in [0.0, 100.0] {
            let b = u32::try_from(positions.len()).unwrap();
            positions.extend([
                [x, 0.0, 0.0],
                [x + 20.0, 0.0, 0.0],
                [x + 20.0, 20.0, 0.0],
                [x, 20.0, 0.0],
            ]);
            triangles.extend([[b, b + 1, b + 2], [b, b + 2, b + 3]]);
        }
        TextureSource {
            parts: vec![SourcePart {
                positions,
                triangles,
                looks: vec![Look::None, Look::None, Look::Color(RED), Look::Color(RED)],
            }],
            ..TextureSource::default()
        }
    }

    #[test]
    fn a_triangle_over_one_that_shows_nothing_stays_unpainted() {
        let src = body_and_label();
        // the same triangles in another order, as an import's repair leaves them: matched by the nearest one
        let mut m = mesh_of(&src.parts[0]);
        m.triangles.reverse();
        let got = paint(&src, &[m], &opts()).unwrap();
        assert_eq!(got.matched.nearest, 4);
        assert!((area_of(&got, 2) - 400.0).abs() < 1e-6, "{:?}", got.area_mm2);
        assert!((got.area_mm2.iter().sum::<f64>() - area_of(&got, 2)).abs() < 1e-9);
    }

    #[test]
    fn a_triangle_far_from_any_textured_one_is_found_at_once() {
        // a big untextured plate 5 m across and one small red triangle in its corner
        let src = TextureSource {
            parts: vec![SourcePart {
                positions: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [5000.0, 5000.0, 0.0],
                    [5001.0, 5000.0, 0.0],
                    [5000.0, 5001.0, 0.0],
                ],
                triangles: vec![[0, 1, 2], [3, 4, 5]],
                looks: vec![Look::Color(RED), Look::None],
            }],
            ..TextureSource::default()
        };
        let mut m = mesh_of(&src.parts[0]);
        m.triangles.reverse();
        let got = paint(&src, &[m], &opts()).unwrap();
        assert_eq!(got.matched.nearest, 2);
        assert!((area_of(&got, 2) - 0.5).abs() < 1e-9, "{:?}", got.area_mm2);
    }

    #[test]
    fn a_thin_part_keeps_its_own_side_even_when_the_repair_turned_it() {
        // a 20 mm card 0.5 mm thick: red underneath (facing down), blue on top (facing up)
        let positions = vec![
            [0.0, 0.0, 0.0],
            [20.0, 0.0, 0.0],
            [20.0, 20.0, 0.0],
            [0.0, 20.0, 0.0],
            [0.0, 0.0, 0.5],
            [20.0, 0.0, 0.5],
            [20.0, 20.0, 0.5],
            [0.0, 20.0, 0.5],
        ];
        let src = TextureSource {
            parts: vec![SourcePart {
                positions,
                triangles: vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]],
                looks: vec![
                    Look::Color(RED),
                    Look::Color(RED),
                    Look::Color(BLUE),
                    Look::Color(BLUE),
                ],
            }],
            ..TextureSource::default()
        };
        // the top turned to face down, as a repair of an inside out shell may leave it
        let mut m = mesh_of(&src.parts[0]);
        m.triangles = vec![[0, 2, 1], [0, 3, 2], [4, 6, 5], [4, 7, 6]];
        let got = paint(&src, &[m], &opts()).unwrap();
        assert_eq!(got.matched.nearest, 4);
        assert!((area_of(&got, 2) - 400.0).abs() < 1e-6, "{:?}", got.area_mm2);
        assert!((area_of(&got, 4) - 400.0).abs() < 1e-6, "{:?}", got.area_mm2);
    }

    #[test]
    fn a_part_painted_with_every_filament_keeps_its_largest_as_paint() {
        let src = square_source();
        let m = mesh_of(&src.parts[0]);
        let got = paint(
            &src,
            &[m.clone(), m],
            &Options {
                paint_every: vec![1],
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(got.parts[0].slot, Some(1));
        assert_eq!(got.parts[1].slot, Some(1));
        let mesh = mesh_of(&src.parts[0]);
        let states = |p: &PartPaint| {
            let (s, bad) = crate::paint_ops::regions(&mesh, &p.paint);
            assert_eq!(bad, 0);
            s.iter().map(|r| r.state).collect::<Vec<_>>()
        };
        assert_eq!(states(&got.parts[0]), vec![2, 3, 4]);
        assert_eq!(states(&got.parts[1]), vec![1, 2, 3, 4]);
    }
}
