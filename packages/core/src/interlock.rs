// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Beam interlocking between filaments (`interlocking_beam`).
//!
//! Orca (`Feature/Interlocking/InterlockingGenerator.cpp` and `VoxelUtils.cpp`, from `CuraEngine`) makes
//! two touching filaments grip each other: where their regions meet, the boundary is cut into beams of
//! `interlocking_beam_width` that alternate between the two filaments, turning a quarter turn every
//! `interlocking_beam_layer_count` layers. A voxel grid of (2 beam widths, 2 beam widths, twice the beam
//! layers) marks the cells that hold both regions within `interlocking_depth` cells of their boundaries;
//! cells near the outside of the part (within `interlocking_boundary_avoidance` cells, its top and bottom
//! included) are dropped so no beam shows; thin strips are grown into their neighbor where beams are
//! near; and the beams of each filament are cut out of the other's outline and added to its own.
//!
//! The planner works on the whole object, so it runs once per session before layers are built.

use crate::fm::Fm as _;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;
use std::collections::{HashMap, HashSet};

type Ring = Vec<IntPoint<i32>>;
type Cell = [i64; 3];

/// Settings of the structure, in internal units except the layer counts and cell depths.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Params {
    pub rotation: f64,
    pub beam_width: i64,
    pub boundary_avoidance: i64,
    pub depth: i64,
    pub beam_layers: i64,
    /// The thinner of the two filaments' outer wall widths.
    pub min_line: i64,
}

/// The settings of `interlocking_beam`, or None when the beams are off or the settings cannot make any
/// (Orca: `generate_interlocking_structure`).
pub(crate) fn params(cfg: &crate::config::PrintConfig) -> Option<Params> {
    if !crate::firmware::truthy(cfg, "interlocking_beam") {
        return None;
    }
    let layers = cfg.raw_number("interlocking_beam_layer_count", 2.0);
    let depth = cfg.raw_number("interlocking_depth", 2.0);
    let width = cfg.raw_number("interlocking_beam_width", 0.8);
    if layers < 1.0 || depth < 1.0 || width < 1e-6 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, reason = "small counts")]
    Some(Params {
        rotation: cfg.raw_number("interlocking_orientation", 22.5).to_radians(),
        beam_width: i64::from(crate::geom::mm(width)),
        boundary_avoidance: cfg.raw_number("interlocking_boundary_avoidance", 2.0).max(0.0) as i64,
        depth: depth as i64,
        beam_layers: layers as i64,
        min_line: i64::from(crate::geom::mm(cfg.outer_wall_width())),
    })
}

/// The ignored gap between the two regions, 0.01 mm (Orca `ignored_gap_`).
const IGNORED_GAP: i32 = 100;

fn grow(s: &Shapes, d: i64) -> Shapes {
    perimeters::offset_round(s, i32::try_from(d).unwrap_or(0))
}

fn shrink(s: &Shapes, d: i64) -> Shapes {
    perimeters::offset(s, -i32::try_from(d).unwrap_or(0))
}

fn closing(s: &Shapes, d: i64) -> Shapes {
    shrink(&grow(s, d), d)
}

fn opening(s: &Shapes, d: i64) -> Shapes {
    grow(&shrink(s, d), d)
}

fn union(a: &Shapes, b: &Shapes) -> Shapes {
    perimeters::union_all(&[a, b])
}

fn xor(a: &Shapes, b: &Shapes) -> Shapes {
    union(&perimeters::difference(a, b), &perimeters::difference(b, a))
}

/// `Point::rotate`: each point turned by `angle` about the origin and rounded.
#[allow(
    clippy::cast_possible_truncation,
    reason = "rounded coordinates of a rotated point"
)]
fn rotate(s: &Shapes, angle: f64) -> Shapes {
    if angle == 0.0 {
        return s.clone();
    }
    let (c, sn) = (angle.m_cos(), angle.m_sin());
    s.iter()
        .map(|shape| {
            shape
                .iter()
                .map(|ring| {
                    ring.iter()
                        .map(|p| {
                            let (x, y) = (f64::from(p.x), f64::from(p.y));
                            IntPoint::new((c * x - sn * y).round() as i32, (c * y + sn * x).round() as i32)
                        })
                        .collect()
                })
                .collect()
        })
        .collect()
}

fn translate(shape: &[Ring], dx: i64, dy: i64) -> Vec<Ring> {
    #[allow(clippy::cast_possible_truncation, reason = "a shift of a fraction of a cell")]
    shape
        .iter()
        .map(|r| {
            r.iter()
                .map(|p| IntPoint::new(p.x + dx as i32, p.y + dy as i32))
                .collect()
        })
        .collect()
}

/// The cells around a reference cell that a dilation touches (Orca `DilationKernel`, prism type).
struct Kernel {
    size: [i64; 3],
    cells: Vec<Cell>,
}

impl Kernel {
    fn prism(size: [i64; 3]) -> Self {
        let mult = size[0] * size[1] * size[2];
        let half = size.map(|s| s / 2);
        let start = half.map(|h| -h);
        let end = [size[0] - half[0], size[1] - half[1], size[2] - half[2]];
        let mut cells = Vec::new();
        for x in start[0]..end[0] {
            for y in start[1]..end[1] {
                for z in start[2]..end[2] {
                    let cur = [x, y, z];
                    let mut limit = [0i64; 3];
                    for d in 0..3 {
                        limit[d] = if cur[d] < 0 { start[d] } else { end[d] - 1 };
                        if limit[d] == 0 {
                            limit[d] = 1;
                        }
                    }
                    let rel = [mult * x / limit[0], mult * y / limit[1], mult * z / limit[2]];
                    if rel[0] + rel[1] > mult {
                        continue;
                    }
                    cells.push(cur);
                }
            }
        }
        Self { size, cells }
    }
}

/// The voxel grid (`VoxelUtils`): cells of `size` in (x, y, layers).
#[derive(Clone, Copy)]
struct Grid {
    size: [i64; 3],
}

impl Grid {
    fn coord(&self, c: i64, dim: usize) -> i64 {
        c / self.size[dim] - i64::from(c < 0)
    }

    fn lower(&self, cell: i64, dim: usize) -> i64 {
        cell * self.size[dim]
    }

    /// Cells a segment crosses (`walkLine`).
    fn walk_line(&self, start: [i64; 3], end: [i64; 3], f: &mut dyn FnMut(Cell)) {
        let diff = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
        let start_cell = [
            self.coord(start[0], 0),
            self.coord(start[1], 1),
            self.coord(start[2], 2),
        ];
        let end_cell = [
            self.coord(end[0], 0),
            self.coord(end[1], 1),
            self.coord(end[2], 2),
        ];
        if start_cell == end_cell {
            f(start_cell);
            return;
        }
        let mut cur = start_cell;
        loop {
            f(cur);
            let mut dim_step: Option<usize> = None;
            let mut best = f64::MAX;
            for d in 0..3 {
                if diff[d] == 0 {
                    continue;
                }
                let boundary = self.lower(cur[d], d) + i64::from(diff[d] > 0) * self.size[d];
                #[allow(clippy::cast_precision_loss, reason = "coordinates well inside 2^52")]
                let pct = (boundary - start[d]) as f64 / diff[d] as f64;
                if pct < best {
                    best = pct;
                    dim_step = Some(d);
                }
            }
            let Some(d) = dim_step else { return };
            if best > 1.0 {
                return;
            }
            cur[d] += if diff[d] > 0 { 1 } else { -1 };
        }
    }

    fn walk_polygons(&self, shape: &[Ring], z: i64, f: &mut dyn FnMut(Cell)) {
        for ring in shape {
            let Some(&first) = ring.last() else { continue };
            let mut last = first;
            for &p in ring {
                self.walk_line(
                    [i64::from(last.x), i64::from(last.y), z],
                    [i64::from(p.x), i64::from(p.y), z],
                    f,
                );
                last = p;
            }
        }
    }

    /// `walkDilatedPolygons`.
    fn walk_dilated_polygons(&self, shape: &[Ring], z: i64, kernel: &Kernel, f: &mut dyn FnMut(Cell)) {
        let k = kernel.size.map(|s| s % 2);
        let t: [i64; 3] = std::array::from_fn(|d| (1 - k[d]) * self.size[d] / 2);
        let moved;
        let shape = if t[0] != 0 && t[1] != 0 {
            moved = translate(shape, t[0], t[1]);
            &moved
        } else {
            shape
        };
        self.walk_polygons(shape, z + t[2], &mut |c| {
            for r in &kernel.cells {
                f([c[0] + r[0], c[1] + r[1], c[2] + r[2]]);
            }
        });
    }

    /// `walkDilatedAreas`: a dot on every grid point inside the area pulled in half a cell (what
    /// Orca's aligned rectilinear fill at cell spacing leaves), each dilated by the kernel.
    fn walk_dilated_areas(&self, shape: &[Ring], z: i64, kernel: &Kernel, f: &mut dyn FnMut(Cell)) {
        let k = kernel.size.map(|s| s % 2);
        let t: [i64; 3] = std::array::from_fn(|d| (1 - k[d]) * self.size[d] / 2 - self.size[d] / 2);
        let moved;
        let shape = if t[0] != 0 && t[1] != 0 {
            moved = translate(shape, t[0], t[1]);
            &moved
        } else {
            shape
        };
        let area: Shapes = vec![shape.to_vec()];
        let inside = perimeters::offset(&area, -i32::try_from(self.size[0] / 2).unwrap_or(0));
        for p in grid_dots(&inside, self.size[0], self.size[1]) {
            let c = [
                self.coord(p[0] + self.size[0] / 2, 0),
                self.coord(p[1] + self.size[1] / 2, 1),
                self.coord(z + t[2], 2),
            ];
            for r in &kernel.cells {
                f([c[0] + r[0], c[1] + r[1], c[2] + r[2]]);
            }
        }
    }
}

/// The grid points `(i * gx, j * gy)` inside an area (even-odd), by scanning each column.
fn grid_dots(area: &Shapes, gx: i64, gy: i64) -> Vec<[i64; 2]> {
    let mut out = Vec::new();
    let Some(b) = perimeters::bounds(area) else {
        return out;
    };
    let (min_x, max_x) = (i64::from(b[0]), i64::from(b[2]));
    let first = (min_x + gx - 1).div_euclid(gx);
    let last = max_x.div_euclid(gx);
    // Crossings of every column with the boundary.
    let mut columns: HashMap<i64, Vec<i64>> = HashMap::new();
    for ring in area.iter().flat_map(|s| s.iter()) {
        let n = ring.len();
        for i in 0..n {
            let (Some(a), Some(c)) = (ring.get(i), ring.get((i + 1) % n)) else {
                continue;
            };
            let (ax, cx) = (i64::from(a.x), i64::from(c.x));
            if ax == cx {
                continue;
            }
            let (lo, hi) = (ax.min(cx), ax.max(cx));
            for col in first.max(lo.div_euclid(gx))..=last.min(hi.div_euclid(gx)) {
                let x = col * gx;
                // A half-open rule on x so a vertex is counted once.
                if !(x >= lo && x < hi) {
                    continue;
                }
                let t = (x - ax) as f64 / (cx - ax) as f64;
                #[allow(clippy::cast_possible_truncation, reason = "a coordinate of the area")]
                let y = (f64::from(a.y) + t * f64::from(c.y - a.y)).round() as i64;
                columns.entry(col).or_default().push(y);
            }
        }
    }
    for (col, mut ys) in columns {
        ys.sort_unstable();
        for pair in ys.chunks(2) {
            let [ya, yb] = pair else { continue };
            let mut y = ya.div_euclid(gy) * gy;
            if y < *ya {
                y += gy;
            }
            while y < *yb {
                out.push([col * gx, y]);
                y += gy;
            }
        }
    }
    out
}

/// Cells holding the outline or skin of `layers`, dilated by `kernel` (Orca `addBoundaryCells`).
fn boundary_cells(layers: &[Shapes], kernel: &Kernel, grid: Grid, cells: &mut HashSet<Cell>) {
    let mut emit = |c: Cell| {
        if c[2] >= 0 {
            cells.insert(c);
        }
    };
    for (l, layer) in layers.iter().enumerate() {
        let z = i64::try_from(l).unwrap_or(0);
        for shape in layer {
            grid.walk_dilated_polygons(shape, z, kernel, &mut emit);
        }
        let mut skin = layer.clone();
        if l > 0
            && let Some(below) = layers.get(l - 1)
        {
            skin = xor(layer, below);
        }
        // Small areas are dropped: the walls cover them already.
        let skin = opening(&skin, grid.size[0] / 2);
        for shape in &skin {
            grid.walk_dilated_areas(shape, z, kernel, &mut emit);
        }
    }
}

/// Layer slices of the regions: `layers[l]` holds `(slot, shapes)`.
pub(crate) type Layers = Vec<Vec<(u8, Shapes)>>;

fn slice_of(layers: &Layers, l: usize, slot: u8) -> Shapes {
    layers
        .get(l)
        .and_then(|r| r.iter().find(|(s, _)| *s == slot))
        .map(|(_, s)| s.clone())
        .unwrap_or_default()
}

fn set_slice(layers: &mut Layers, l: usize, slot: u8, shapes: Shapes) {
    let Some(regions) = layers.get_mut(l) else { return };
    if let Some(r) = regions.iter_mut().find(|(s, _)| *s == slot) {
        r.1 = shapes;
    } else if !shapes.is_empty() {
        regions.push((slot, shapes));
    }
}

/// Gives every pair of filaments that touch the interlocking beams.
pub(crate) fn apply(layers: &mut Layers, p: &Params) {
    let mut slots: Vec<u8> = layers.iter().flat_map(|r| r.iter().map(|(s, _)| *s)).collect();
    slots.sort_unstable();
    slots.dedup();
    for (i, &a) in slots.iter().enumerate() {
        for &b in slots.iter().skip(i + 1) {
            pair(layers, a, b, p);
        }
    }
}

fn pair(layers: &mut Layers, a: u8, b: u8, p: &Params) {
    let n = layers.len();
    let cell_w = 2 * p.beam_width;
    let grid = Grid {
        size: [cell_w, cell_w, 2 * p.beam_layers],
    };
    let interface = Kernel::prism([p.depth; 3]);
    // Cells near the boundary or skin of each region, and the cells both reach.
    let shell = |slot: u8| -> HashSet<Cell> {
        let rotated: Vec<Shapes> = (0..n)
            .map(|l| rotate(&slice_of(layers, l, slot), p.rotation))
            .collect();
        let mut cells = HashSet::new();
        boundary_cells(&rotated, &interface, grid, &mut cells);
        cells
    };
    let (set_a, set_b) = (shell(a), shell(b));
    let mut both: HashSet<Cell> = set_a.intersection(&set_b).copied().collect();
    if both.is_empty() {
        return;
    }
    // Both regions together, small gaps closed, with a ghost layer on top.
    let mut unioned: Vec<Shapes> = (0..n)
        .map(|l| {
            let u = union(&slice_of(layers, l, a), &slice_of(layers, l, b));
            rotate(&closing(&u, i64::from(IGNORED_GAP)), p.rotation)
        })
        .collect();
    unioned.push(Shapes::new());
    if p.boundary_avoidance > 0 {
        let air = Kernel::prism([p.boundary_avoidance; 3]);
        let mut air_cells = HashSet::new();
        boundary_cells(&unioned, &air, grid, &mut air_cells);
        for c in &air_cells {
            both.remove(c);
        }
        thin_areas(layers, a, b, &both, p, grid);
    }
    microstructure(layers, a, b, &both, &unioned, p, grid);
}

/// Orca `growBorderAreasPerpendicular`.
fn grow_borders(a: &Shapes, b: &Shapes, detect: i64, p: &Params) -> (Shapes, Shapes) {
    let min_line = p.min_line;
    let total_shrunk = shrink(&union(&grow(a, min_line), &grow(b, min_line)), 2 * min_line);
    let mut from_a = perimeters::difference(a, &total_shrunk);
    let mut from_b = perimeters::difference(b, &total_shrunk);
    for _ in 0..(detect / min_line.max(1)) + 2 {
        let (ta, tb) = (grow(&from_a, min_line), grow(&from_b, min_line));
        from_a = perimeters::difference(&ta, &tb);
        from_b = perimeters::difference(&tb, &ta);
    }
    (from_a, from_b)
}

/// Orca `handleThinAreas`: a thin strip of one filament grows into its neighbor where beams are near.
fn thin_areas(layers: &mut Layers, a: u8, b: u8, cells: &HashSet<Cell>, p: &Params, grid: Grid) {
    let n = layers.len();
    let rounding = 5;
    let detect = p.beam_width * p.boundary_avoidance + rounding;
    let expand = p.beam_width * (p.boundary_avoidance - 1) + rounding;
    let close_gaps = p.min_line / 4;
    // Cell footprints per layer.
    let mut near: Vec<Vec<Ring>> = vec![Vec::new(); n];
    for c in cells {
        let (x, y) = (grid.lower(c[0], 0), grid.lower(c[1], 1));
        let z0 = grid.lower(c[2], 2);
        #[allow(clippy::cast_possible_truncation, reason = "cell corners inside the bed")]
        let square = vec![
            IntPoint::new(x as i32, y as i32),
            IntPoint::new((x + grid.size[0]) as i32, y as i32),
            IntPoint::new((x + grid.size[0]) as i32, (y + grid.size[1]) as i32),
            IntPoint::new(x as i32, (y + grid.size[1]) as i32),
        ];
        for l in z0.max(0)..(z0 + grid.size[2]).min(i64::try_from(n).unwrap_or(0)) {
            if let Some(list) = near.get_mut(usize::try_from(l).unwrap_or(0)) {
                list.push(square.clone());
            }
        }
    }
    let near: Vec<Shapes> = crate::par::map(&near, |rings| {
        if rings.is_empty() {
            return Shapes::new();
        }
        let shapes: Shapes = rings.iter().map(|r| vec![r.clone()]).collect();
        let merged = closing(&perimeters::union_all(&[&shapes]), rounding);
        // Orca turns these by the structure's rotation again (the same direction as the cells were
        // turned in), and so do we.
        rotate(&grow(&merged, detect), p.rotation)
    });
    for l in 0..n {
        let (pa, pb) = (slice_of(layers, l, a), slice_of(layers, l, b));
        if pa.is_empty() && pb.is_empty() {
            continue;
        }
        let (from_a, from_b) = grow_borders(&pa, &pb, detect, p);
        let (large_a, large_b) = (opening(&pa, detect), opening(&pb, detect));
        let near_l = near.get(l).cloned().unwrap_or_default();
        let expansion = |thin: &Shapes, large_other: &Shapes, from: &Shapes| -> Shapes {
            let thin_grown = grow(thin, expand);
            let hit = perimeters::intersection(&perimeters::intersection(large_other, &thin_grown), &near_l);
            grow(&perimeters::intersection(&hit, from), rounding)
        };
        let thin_a = expansion(&perimeters::difference(&pa, &large_a), &large_b, &from_a);
        let thin_b = expansion(&perimeters::difference(&pb, &large_b), &large_a, &from_b);
        let new_a = closing(&perimeters::difference(&union(&pa, &thin_a), &thin_b), close_gaps);
        let new_b = closing(&perimeters::difference(&union(&pb, &thin_b), &thin_a), close_gaps);
        set_slice(layers, l, a, new_a);
        set_slice(layers, l, b, new_b);
    }
}

/// Orca `generateMicrostructure` and `applyMicrostructureToOutlines`.
fn microstructure(
    layers: &mut Layers,
    a: u8,
    b: u8,
    cells: &HashSet<Cell>,
    unioned: &[Shapes],
    p: &Params,
    grid: Grid,
) {
    let n = layers.len();
    let cell_w = grid.size[0];
    let middle = cell_w * p.beam_width / (2 * p.beam_width);
    let widths = [middle, cell_w - middle];
    // Beams of one cell for both filaments, in both orientations: x stripes, then y stripes.
    let beam = |mesh: usize, swap: bool| -> Ring {
        #[allow(clippy::cast_possible_truncation, reason = "cell sizes of a few millimeters")]
        let (ox, w, h) = (
            if mesh == 1 { middle } else { 0 } as i32,
            widths[mesh] as i32,
            cell_w as i32,
        );
        let pts = [(ox, 0), (ox + w, 0), (ox + w, h), (ox, h)];
        pts.iter()
            .map(|&(x, y)| {
                if swap {
                    IntPoint::new(y, x)
                } else {
                    IntPoint::new(x, y)
                }
            })
            .collect()
    };
    let beam_layers = p.beam_layers.max(1);
    let groups =
        usize::try_from((i64::try_from(n).unwrap_or(0) + beam_layers - 1) / beam_layers).unwrap_or(0);
    let mut structure: [Vec<Vec<Ring>>; 2] = [vec![Vec::new(); groups], vec![Vec::new(); groups]];
    for c in cells {
        let (bx, by, bz) = (grid.lower(c[0], 0), grid.lower(c[1], 1), grid.lower(c[2], 2));
        for (mesh, per_layer) in structure.iter_mut().enumerate() {
            let mut l = bz;
            while l < bz + grid.size[2] && l < i64::try_from(n).unwrap_or(0) {
                if l >= 0 {
                    let g = usize::try_from(l / beam_layers).unwrap_or(0);
                    let swap = g % 2 == 1;
                    let ring = translate(&[beam(mesh, swap)], bx, by);
                    if let (Some(list), Some(r)) = (per_layer.get_mut(g), ring.into_iter().next()) {
                        list.push(r);
                    }
                }
                l += beam_layers;
            }
        }
    }
    let structure: Vec<Vec<Shapes>> = structure
        .iter()
        .map(|per_layer| {
            crate::par::map(per_layer, |rings| {
                let shapes: Shapes = rings.iter().map(|r| vec![r.clone()]).collect();
                rotate(&perimeters::union_all(&[&shapes]), -p.rotation)
            })
        })
        .collect();
    for (mesh, slot) in [(0usize, a), (1usize, b)] {
        for l in 0..n {
            let g = usize::try_from(i64::try_from(l).unwrap_or(0) / beam_layers).unwrap_or(0);
            let outline = rotate(unioned.get(l).map_or(&Vec::new(), |u| u), -p.rotation);
            let own = structure
                .get(mesh)
                .and_then(|s| s.get(g))
                .cloned()
                .unwrap_or_default();
            let other = structure
                .get(1 - mesh)
                .and_then(|s| s.get(g))
                .cloned()
                .unwrap_or_default();
            let here = perimeters::intersection(&own, &outline);
            let polys = slice_of(layers, l, slot);
            set_slice(
                layers,
                l,
                slot,
                union(&perimeters::difference(&polys, &other), &here),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: i32, y0: i32, x1: i32, y1: i32) -> Shapes {
        vec![vec![vec![
            IntPoint::new(x0, y0),
            IntPoint::new(x1, y0),
            IntPoint::new(x1, y1),
            IntPoint::new(x0, y1),
        ]]]
    }

    fn area(s: &Shapes) -> i64 {
        s.iter()
            .map(|sh| {
                sh.iter()
                    .enumerate()
                    .map(|(i, r)| {
                        let a = crate::geom::area2_int(r).abs() / 2;
                        if i == 0 { a } else { -a }
                    })
                    .sum::<i64>()
            })
            .sum()
    }

    #[test]
    fn the_prism_kernel_of_depth_two_has_six_cells() {
        let k = Kernel::prism([2, 2, 2]);
        assert_eq!(k.cells.len(), 6, "{:?}", k.cells);
    }

    #[test]
    fn a_line_crossing_cells_visits_each_once() {
        let g = Grid { size: [10, 10, 4] };
        let mut seen: Vec<Cell> = Vec::new();
        g.walk_line([5, 5, 0], [35, 5, 0], &mut |c| seen.push(c));
        assert_eq!(seen, vec![[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]);
    }

    #[test]
    fn two_filaments_side_by_side_swap_beams_along_their_joint() {
        // Two 20 mm blocks touching along x = 20 mm, 40 layers tall.
        let units: i32 = 10_000;
        let mut layers: Layers = (0..40)
            .map(|_| {
                vec![
                    (1, rect(0, 0, 20 * units, 20 * units)),
                    (2, rect(20 * units, 0, 40 * units, 20 * units)),
                ]
            })
            .collect();
        let before: Vec<i64> = [1u8, 2]
            .iter()
            .map(|s| area(&slice_of(&layers, 20, *s)))
            .collect();
        apply(
            &mut layers,
            &Params {
                rotation: 0.0,
                beam_width: 8_000,
                boundary_avoidance: 2,
                depth: 2,
                beam_layers: 2,
                min_line: 4_200,
            },
        );
        let after: Vec<i64> = [1u8, 2]
            .iter()
            .map(|s| area(&slice_of(&layers, 20, *s)))
            .collect();
        // The shapes changed (beams cut out of one filament and added to the other) and the total stays.
        assert_eq!(before.len(), after.len());
        let (a0, a1) = (area(&slice_of(&layers, 20, 1)), area(&slice_of(&layers, 20, 2)));
        assert!(
            (a0 + a1 - (before[0] + before[1])).abs() < before[0] / 50,
            "{a0} {a1} {before:?}"
        );
        // On the layers whose beams run along x, filament 2 reaches into x < 20 mm along the joint, and
        // filament 1 into x > 20 mm; on the others the beams meet at the joint itself.
        let reach = |slot: u8, l: usize| {
            let s = slice_of(&layers, l, slot);
            perimeters::bounds(&s).map_or((i32::MAX, i32::MIN), |b| (b[0], b[2]))
        };
        assert!((8..32).any(|l| reach(2, l).0 < 20 * units), "no layer interlocks");
        assert!((8..32).any(|l| reach(1, l).1 > 20 * units), "no layer interlocks");
        // Near the top and bottom nothing is changed (boundary avoidance).
        assert_eq!(reach(2, 0).0, 20 * units);
        assert_eq!(reach(2, 39).0, 20 * units);
    }
}
