// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Adaptive cubic and support cubic infill: a cubic lattice whose cells are big in the middle of the
//! part and small near its surface, so the infill is dense where the shell needs holding up and thin
//! elsewhere. The method is Cura's adaptive cubic subdivision, which `OrcaSlicer` follows:
//!
//! - an octree of cubes that stand on a corner (the lattice is rotated so its diagonal is vertical)
//!   is split wherever it touches a triangle of the model, down to cells two line spacings wide;
//! - on each layer, every cell contributes the piece of its three wall planes that the layer's plane
//!   cuts, and pieces of neighboring cells that line up are joined into one line;
//! - support cubic only splits around the model's upward facing triangles, so it is dense just
//!   under top surfaces.
//!
//! Lengths are in mm.
#![allow(
    clippy::indexing_slicing,
    reason = "fixed-size 3-vectors and matrices, indexed by axis"
)]

use crate::fm::Fm as _;
type V = [f64; 3];
type P = [f64; 2];

const EPS: f64 = 1e-4;

/// Rotation of the octree so the cubes stand on a corner (Euler angles about x, y, z).
const ROT: [f64; 3] = [
    5.0 * std::f64::consts::FRAC_PI_4,
    215.264 * std::f64::consts::PI / 180.0,
    std::f64::consts::FRAC_PI_6,
];

/// A row-major 3x3 rotation matrix.
type M = [[f64; 3]; 3];

fn rot_x(a: f64) -> M {
    let (s, c) = a.m_sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}
fn rot_y(a: f64) -> M {
    let (s, c) = a.m_sin_cos();
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}
fn rot_z(a: f64) -> M {
    let (s, c) = a.m_sin_cos();
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}
fn mul(a: M, b: M) -> M {
    let mut r = [[0.0; 3]; 3];
    for (i, row) in r.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    r
}
fn apply(m: M, v: V) -> V {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn to_octree() -> M {
    mul(mul(rot_x(-ROT[0]), rot_y(-ROT[1])), rot_z(-ROT[2]))
}
fn to_world() -> M {
    mul(mul(rot_z(ROT[2]), rot_y(ROT[1])), rot_x(ROT[0]))
}

#[derive(Debug, Clone, Copy)]
struct Props {
    edge: f64,
    height: f64,
    diagonal: f64,
    line_z: f64,
    line_xy: f64,
}

impl Props {
    fn new(edge: f64) -> Self {
        Self {
            edge,
            height: edge * 3.0_f64.sqrt(),
            diagonal: edge * 2.0_f64.sqrt(),
            line_z: edge / 3.0_f64.sqrt(),
            line_xy: edge / 6.0_f64.sqrt(),
        }
    }
}

#[derive(Debug, Clone)]
struct Cube {
    center: V,
    children: [Option<Box<Cube>>; 8],
}

impl Cube {
    fn new(center: V) -> Self {
        Self {
            center,
            children: Default::default(),
        }
    }
}

/// The octree of one model.
#[derive(Debug, Clone)]
pub(crate) struct Octree {
    props: Vec<Props>,
    root: Cube,
}

const CHILD_DIRS: [V; 8] = [
    [-1.0, -1.0, -1.0],
    [1.0, -1.0, -1.0],
    [-1.0, 1.0, -1.0],
    [1.0, 1.0, -1.0],
    [-1.0, -1.0, 1.0],
    [1.0, -1.0, 1.0],
    [-1.0, 1.0, 1.0],
    [1.0, 1.0, 1.0],
];

/// Order the children are walked in for each of the three line directions, so a line continues from
/// one cell into the next.
const TRAVERSAL: [[usize; 8]; 3] = [
    [2, 3, 0, 1, 6, 7, 4, 5],
    [4, 0, 6, 2, 5, 1, 7, 3],
    [1, 5, 0, 4, 3, 7, 2, 6],
];

/// Line spacing of the lattice for a density (percent) and line width (mm).
pub(crate) fn line_spacing(density_percent: f64, line_width: f64) -> f64 {
    line_width / ((density_percent / 100.0) * 0.333_333_333)
}

/// Builds the octree from triangles in plate coordinates. With `up_only`, only triangles that face
/// upward (more than 45 degrees from the horizontal plane, seen from above) count.
pub(crate) fn build(triangles: &[[V; 3]], extra: &[[V; 3]], spacing: f64, up_only: bool) -> Option<Octree> {
    if triangles.is_empty() || spacing <= 0.0 {
        return None;
    }
    let r = to_octree();
    let tris: Vec<[V; 3]> = triangles
        .iter()
        .chain(extra)
        .map(|t| t.map(|v| apply(r, v)))
        .collect();
    let n_model = triangles.len();
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    for t in &tris {
        for v in t {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
    }
    let size = (hi[0] - lo[0]).max(hi[1] - lo[1]).max(hi[2] - lo[2]);
    let center = [
        f64::midpoint(lo[0], hi[0]),
        f64::midpoint(lo[1], hi[1]),
        f64::midpoint(lo[2], hi[2]),
    ];
    // Cube sizes from two line spacings up, doubling, until one is wider than the model.
    let mut props = Vec::new();
    let mut edge = spacing * 2.0;
    loop {
        props.push(Props::new(edge));
        if edge > size + EPS {
            break;
        }
        edge *= 2.0;
    }
    if props.len() == 1 {
        props.push(Props::new(edge * 2.0));
    }
    let mut octree = Octree {
        root: Cube::new(center),
        props,
    };
    let half = 0.5 * octree.props.last().map_or(0.0, |p| p.edge);
    let bbox = (
        [center[0] - half, center[1] - half, center[2] - half],
        [center[0] + half, center[1] + half, center[2] + half],
    );
    let depth = octree.props.len() - 1;
    let up = apply(r, [0.0, 0.0, 1.0]);
    for (k, t) in tris.iter().enumerate() {
        // The extra triangles (where solid infill will rest on sparse infill) always count.
        if up_only && k < n_model && !faces_up(t, up) {
            continue;
        }
        let props = octree.props.clone();
        insert(&props, &mut octree.root, t, bbox, depth);
    }
    // The centers go back to world coordinates, so extracting lines needs no rotation.
    let w = to_world();
    world_centers(&mut octree.root, w);
    Some(octree)
}

fn faces_up(t: &[V; 3], up: V) -> bool {
    let (a, b, c) = (t[0], t[1], t[2]);
    let (u, v) = (
        [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        [c[0] - b[0], c[1] - b[1], c[2] - b[2]],
    );
    let n = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    n[0] * up[0] + n[1] * up[1] + n[2] * up[2] > 0.707 * nl
}

fn world_centers(c: &mut Cube, w: M) {
    c.center = apply(w, c.center);
    for child in c.children.iter_mut().flatten() {
        world_centers(child, w);
    }
}

fn insert(props: &[Props], cube: &mut Cube, tri: &[V; 3], bbox: (V, V), depth: usize) {
    let depth = depth - 1;
    let Some(p) = props.get(depth) else { return };
    for (i, dir) in CHILD_DIRS.iter().enumerate() {
        let (mut lo, mut hi) = ([0.0; 3], [0.0; 3]);
        for k in 0..3 {
            if dir[k] < 0.0 {
                lo[k] = bbox.0[k];
                hi[k] = cube.center[k] + EPS;
            } else {
                lo[k] = cube.center[k] - EPS;
                hi[k] = bbox.1[k];
            }
        }
        let child_center = [
            cube.center[0] + dir[0] * p.edge / 2.0,
            cube.center[1] + dir[1] * p.edge / 2.0,
            cube.center[2] + dir[2] * p.edge / 2.0,
        ];
        if triangle_box(tri, lo, hi) {
            let child = cube.children[i].get_or_insert_with(|| Box::new(Cube::new(child_center)));
            if depth > 0 {
                insert(props, child, tri, (lo, hi), depth);
            }
        }
    }
}

/// Separating axis test of a triangle against an axis-aligned box.
fn triangle_box(t: &[V; 3], lo: V, hi: V) -> bool {
    let (a, b, c) = (t[0], t[1], t[2]);
    for k in 0..3 {
        let (tmin, tmax) = (a[k].min(b[k]).min(c[k]), a[k].max(b[k]).max(c[k]));
        if tmin >= hi[k] || tmax <= lo[k] {
            return false;
        }
    }
    let center = [
        f64::midpoint(lo[0], hi[0]),
        f64::midpoint(lo[1], hi[1]),
        f64::midpoint(lo[2], hi[2]),
    ];
    let h = [hi[0] - center[0], hi[1] - center[1], hi[2] - center[2]];
    let sub = |p: V, q: V| [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    let (pa, pb, pc) = (sub(a, center), sub(b, center), sub(c, center));
    let edges = [sub(b, a), sub(c, a), sub(c, b)];
    let n = [
        edges[0][1] * edges[1][2] - edges[0][2] * edges[1][1],
        edges[0][2] * edges[1][0] - edges[0][0] * edges[1][2],
        edges[0][0] * edges[1][1] - edges[0][1] * edges[1][0],
    ];
    let s = n[0] * pa[0] + n[1] * pa[1] + n[2] * pa[2];
    let r = h[0] * n[0].abs() + h[1] * n[1].abs() + h[2] * n[2].abs();
    if s.abs() >= r {
        return false;
    }
    // The nine cross products of box axes and triangle edges.
    for e in &edges {
        for axis in 0..3 {
            let mut ax = [0.0; 3];
            ax[axis] = 1.0;
            let cross = [
                ax[1] * e[2] - ax[2] * e[1],
                ax[2] * e[0] - ax[0] * e[2],
                ax[0] * e[1] - ax[1] * e[0],
            ];
            let proj = |p: V| cross[0] * p[0] + cross[1] * p[1] + cross[2] * p[2];
            let (d0, d1, d2) = (proj(pa), proj(pb), proj(pc));
            let (tmin, tmax) = (d0.min(d1).min(d2), d0.max(d1).max(d2));
            let rad = h[0] * cross[0].abs() + h[1] * cross[1].abs() + h[2] * cross[2].abs();
            if tmin > rad || tmax < -rad {
                return false;
            }
        }
    }
    true
}

struct Fill<'a> {
    props: &'a [Props],
    z: f64,
    order: &'a [usize; 8],
    cos: f64,
    sin: f64,
    temp: Vec<Option<(P, P)>>,
    out: Vec<(P, P)>,
}

impl Fill<'_> {
    fn rotate(&self, v: P) -> P {
        [
            self.cos * v[0] - self.sin * v[1],
            self.sin * v[0] + self.cos * v[1],
        ]
    }

    fn walk(&mut self, cube: &Cube, address: usize, depth: usize) {
        let Some(p) = self.props.get(depth).copied() else {
            return;
        };
        let z_diff = self.z - cube.center[2];
        let z_abs = z_diff.abs();
        if z_abs > p.height / 2.0 {
            return;
        }
        if z_abs < p.line_z {
            // One wall through the cube.
            let zd = p.line_z;
            let from = [
                0.5 * p.diagonal * (zd - z_abs) / zd,
                p.line_xy - (zd + z_diff) / 2.0_f64.sqrt(),
            ];
            let to = [-from[0], from[1]];
            let (from, to) = (self.rotate(from), self.rotate(to));
            let new_a = [from[0] + cube.center[0], from[1] + cube.center[1]];
            let new_b = [to[0] + cube.center[0], to[1] + cube.center[1]];
            if let Some(slot) = self.temp.get_mut(address) {
                match slot {
                    None => *slot = Some((new_a, new_b)),
                    Some((a, b)) => {
                        if (new_a[0] - b[0]).abs().max((new_a[1] - b[1]).abs()) > 0.001 {
                            self.out.push((*a, *b));
                            *a = new_a;
                        }
                        *b = new_b;
                    }
                }
            }
        }
        let mut address = address * 2 + 1;
        let order = *self.order;
        for (i, &c) in order.iter().enumerate() {
            if let Some(Some(child)) = cube.children.get(c).map(Option::as_ref) {
                self.walk(child, address, depth.wrapping_sub(1));
            }
            if i + 1 == 4 {
                address += 1;
            }
        }
    }
}

/// The lattice lines on the plane `z` (mm), as segments.
pub(crate) fn lines(octree: &Octree, z: f64) -> Vec<[P; 2]> {
    let levels = octree.props.len();
    let angles = [
        0.0,
        2.0 * std::f64::consts::PI / 3.0,
        -2.0 * std::f64::consts::PI / 3.0,
    ];
    let mut all: Vec<[P; 2]> = Vec::new();
    for (dir, angle) in angles.iter().enumerate() {
        let order = TRAVERSAL.get(dir).copied().unwrap_or(TRAVERSAL[0]);
        let mut f = Fill {
            props: &octree.props,
            z,
            order: &order,
            cos: angle.m_cos(),
            sin: angle.m_sin(),
            temp: vec![None; (1usize << levels) - 1],
            out: Vec::new(),
        };
        f.walk(&octree.root, 0, levels - 1);
        all.extend(f.out.iter().map(|(a, b)| [*a, *b]));
        all.extend(f.temp.iter().flatten().map(|(a, b)| [*a, *b]));
    }
    all
}
