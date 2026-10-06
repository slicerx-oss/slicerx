// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Sparse infill patterns beyond rectilinear and grid. Each pattern is drawn
//! over the bounds of the region in plate coordinates, so it lines up from
//! layer to layer, then cut to the region with the same edge grid the
//! overhang code uses. Line patterns are parallel line sets at fixed angles;
//! honeycomb and gyroid are chains of short segments joined end to end;
//! concentric is offset loops.

// Cell and row counts are small and non-negative, so these casts are exact.
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use crate::config::InfillPattern;
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::overhang::Support;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;
use std::f64::consts::{FRAC_PI_2, PI};

type Pt = IntPoint<i32>;

/// Pieces shorter than this fraction of a line width are dropped.
const MIN_PIECE: f64 = 0.5;

/// What one layer's sparse pattern needs.
#[derive(Clone, Copy)]
pub(crate) struct SparseIn<'a> {
    pub pattern: InfillPattern,
    /// The sparse infill area of the layer.
    pub region: &'a Shapes,
    /// Line width, and the distance between neighboring beads at full density, mm.
    pub w_mm: f64,
    pub spacing_mm: f64,
    /// A fraction 0 to 1.
    pub density: f64,
    /// The layer's top (print z), mm, and its index.
    pub z_mm: f64,
    pub layer: u32,
    /// Longest boundary piece that joins two lines and the anchor hook length, mm (0 keeps lines apart).
    pub connect_mm: f64,
    pub anchor_mm: f64,
    /// Box of the plate's objects `[min_x, min_y, max_x, max_y]`, mm: its center is the reference of the
    /// line phases (Orca's object bounding box).
    pub object: [f64; 4],
    /// The infill direction setting, degrees.
    pub angle_deg: f64,
    /// The two lateral lattice angles, degrees from vertical.
    pub lateral_angles: [f64; 2],
    /// The angle of the slanted legs of the lateral honeycomb, degrees (60 is a regular honeycomb).
    pub overhang_angle_deg: f64,
    /// A rotation template sets `angle_deg` for this layer: the patterns that turn per layer keep it
    /// (Orca's `fixed_angle`).
    pub fixed_angle: bool,
    /// `gyroid_optimized`: the layer height (mm) the gyroid's Z period is tuned for; `None` draws the plain
    /// gyroid.
    pub gyroid_layer_height: Option<f64>,
}

/// Sparse infill polylines for one layer inside the region of `inp`: Orca's pattern generators
/// (`Fill/*.cpp`) with their angles, spacing, per layer turns and height dependence, cut to the region and
/// joined along its edge (`anchor.rs`).
pub(crate) fn sparse(inp: &SparseIn<'_>) -> Vec<Vec<Point>> {
    if inp.density <= 0.0 || inp.region.is_empty() {
        return Vec::new();
    }
    // Orca's `Fill::fill_surface` pulls the surface in half a spacing before any pattern sees it (the
    // overlap of a fill is 0), so lines, cuts and the boundary lines are joined along all use that area.
    // The multi-sweep fills (`FillRectilinear::fill_surface_by_multilines`) do their own.
    if is_multiline(inp.pattern) {
        return sparse_on(inp);
    }
    let eff = contracted(inp);
    // The minimal surface fills turn the surface by the infill angle less 45 degrees before drawing
    // (`CorrectionAngle`), and the lines back after.
    if matches!(inp.pattern, InfillPattern::TpmsD | InfillPattern::TpmsFk) {
        let turn = (inp.angle_deg - 45.0).to_radians();
        if turn.abs() > 1e-6 {
            let rotated = rotate_shapes(&eff, -turn);
            let lines = sparse_on(&SparseIn {
                region: &rotated,
                ..*inp
            });
            return lines.into_iter().map(|l| rotate_points(&l, turn)).collect();
        }
    }
    sparse_on(&SparseIn { region: &eff, ..*inp })
}

/// Orca's `FillLateralHoneycomb`: the base cell is an inverted Y whose junction sits at height zero, so a
/// layer is either one line (above the junction, two thirds of the height of the cell) or two lines that
/// meet at the junction (the lower third), the pair coming together with height and the next cell shifted by
/// half a period. The lines run on the shared sweep lattice (`multilines`) and every odd layer is walked back.
fn lateral_honeycomb(inp: &SparseIn<'_>) -> Vec<Vec<Pt>> {
    let half_period = f64::midpoint(2.0 / 3.0, 2.0 * (1.0 / 3.0)) * inp.spacing_mm / inp.density;
    let vertical_period = 3.0 * half_period / inp.overhang_angle_deg.to_radians().m_tan();
    let thirds = 3.0 * inp.z_mm / vertical_period;
    let thirds_int = thirds.floor();
    let single_line = (thirds_int as i64 + 1) % 3 != 0;
    let odd_cell = ((thirds_int as i64 + 1) / 3) % 2 != 0;
    let offset = if odd_cell { half_period } else { 0.0 };
    let (density, sweeps) = if single_line {
        (
            inp.density / (2.0 / 3.0 + 2.0 * (1.0 / 3.0)),
            vec![(FRAC_PI_2, offset)],
        )
    } else {
        let position = (1.0 - (thirds - thirds_int)) * half_period;
        (
            inp.density * 2.0 / (2.0 / 3.0 + 2.0 * (1.0 / 3.0)),
            vec![(FRAC_PI_2, -position + offset), (FRAC_PI_2, position + offset)],
        )
    };
    let mut lines = multilines(&SparseIn { density, ..*inp }, &sweeps);
    if inp.layer % 2 == 1 {
        for l in &mut lines {
            l.reverse();
        }
    }
    lines
}

/// `p` turned by `angle` radians about the origin.
pub(crate) fn rotate_points(p: &[Point], angle: f64) -> Vec<Point> {
    let (s, c) = angle.m_sin_cos();
    p.iter()
        .map(|q| {
            let (x, y) = (f64::from(q.x), f64::from(q.y));
            Point::new((x * c - y * s).round() as i32, (x * s + y * c).round() as i32)
        })
        .collect()
}

/// The region turned by `angle` radians about the origin.
pub(crate) fn rotate_shapes(region: &Shapes, angle: f64) -> Shapes {
    let (s, c) = angle.m_sin_cos();
    region
        .iter()
        .map(|shape| {
            shape
                .iter()
                .map(|ring| {
                    ring.iter()
                        .map(|q| {
                            let (x, y) = (f64::from(q.x), f64::from(q.y));
                            Pt::new((x * c - y * s).round() as i32, (x * s + y * c).round() as i32)
                        })
                        .collect()
                })
                .collect()
        })
        .collect()
}

/// The patterns drawn as several sweeps of parallel lines.
fn is_multiline(pattern: InfillPattern) -> bool {
    matches!(
        pattern,
        InfillPattern::Grid
            | InfillPattern::Triangles
            | InfillPattern::Stars
            | InfillPattern::Cubic
            | InfillPattern::QuarterCubic
            | InfillPattern::LateralLattice
            | InfillPattern::LateralHoneycomb
    )
}

fn sparse_on(inp: &SparseIn<'_>) -> Vec<Vec<Point>> {
    let SparseIn {
        pattern,
        region,
        w_mm,
        spacing_mm,
        density,
        z_mm,
        layer,
        connect_mm,
        anchor_mm,
        ..
    } = *inp;
    if density <= 0.0 || region.is_empty() {
        return Vec::new();
    }
    let Some(b) = perimeters::bounds(region) else {
        return Vec::new();
    };
    if pattern == InfillPattern::Concentric {
        return concentric(region, spacing_mm / density, spacing_mm);
    }
    // A margin, so no line starts exactly on the region's edge.
    let m = 2.0 * SCALE;
    let bbox = [
        f64::from(b[0]) - m,
        f64::from(b[1]) - m,
        f64::from(b[2]) + m,
        f64::from(b[3]) + m,
    ];
    let pitch_of = |sets: f64| spacing_mm * sets / density * SCALE;
    let mut raw: Vec<Vec<Pt>> = Vec::new();
    match pattern {
        // The line fill is already cut and joined, its ends reaching a little past the region.
        InfillPattern::Line => {
            return line_fill(inp)
                .into_iter()
                .map(|p| p.into_iter().map(|q| Point::new(q.x, q.y)).collect())
                .collect();
        }
        // Orca's FillGrid, FillTriangles, FillStars and FillCubic: several sweeps of parallel lines
        // (`FillRectilinear::fill_surface_by_multilines`), each at a fraction of the density, joined after.
        InfillPattern::Grid => raw = multilines(inp, &[(0.0, 0.0), (FRAC_PI_2, 0.0)]),
        InfillPattern::Triangles => {
            raw = multilines(inp, &[(0.0, 0.0), (PI / 3.0, 0.0), (2.0 * PI / 3.0, 0.0)]);
        }
        InfillPattern::QuarterCubic => {
            // Two tetrahedral halves: the shift of each follows the height, folded and kept clear of the
            // neighboring line (`FillQuarterCubic`).
            let period = spacing_mm / density * 4.0;
            let shift = |extra: f64| -> f64 {
                let s = (0.5_f64.sqrt() * (z_mm + extra * period * 2.0)).rem_euclid(period);
                let s = s.min(period - s).min(period / 2.0 - spacing_mm / 2.0);
                s.max(spacing_mm / 2.0)
            };
            let (dx1, dx2) = (shift(0.0), shift(0.5));
            raw = multilines(
                inp,
                &[(0.0, dx1), (0.0, -dx1), (FRAC_PI_2, dx2), (FRAC_PI_2, -dx2)],
            );
        }
        InfillPattern::LateralLattice => {
            let (a1, a2) = (
                inp.lateral_angles[0].to_radians(),
                inp.lateral_angles[1].to_radians(),
            );
            raw = multilines(
                inp,
                &[(FRAC_PI_2, a1.m_tan() * z_mm), (FRAC_PI_2, a2.m_tan() * z_mm)],
            );
        }
        InfillPattern::LateralHoneycomb => raw = lateral_honeycomb(inp),
        InfillPattern::HilbertCurve | InfillPattern::ArchimedeanChords | InfillPattern::OctagramSpiral => {
            let curve = match pattern {
                InfillPattern::HilbertCurve => crate::surface::Curve::Hilbert,
                InfillPattern::ArchimedeanChords => crate::surface::Curve::Archimedean,
                _ => crate::surface::Curve::Octagram,
            };
            // `FillPlanePath` does not turn per layer: the frame is the infill angle plus a right angle.
            let frame = -(inp.angle_deg + 90.0);
            raw = crate::surface::fill_plane(
                region,
                curve,
                spacing_mm,
                spacing_mm / density,
                frame,
                Some(inp.object),
            )
            .into_iter()
            .map(|pl| {
                pl.into_iter()
                    .map(|q| pt(f64::from(q.x), f64::from(q.y)))
                    .collect()
            })
            .collect();
        }
        InfillPattern::Stars => {
            let shift = 1.5 * spacing_mm / density;
            raw = multilines(inp, &[(0.0, 0.0), (PI / 3.0, 0.0), (2.0 * PI / 3.0, shift)]);
        }
        InfillPattern::Cubic => {
            let dx = 0.5_f64.sqrt() * z_mm;
            raw = multilines(inp, &[(0.0, dx), (PI / 3.0, -dx), (2.0 * PI / 3.0, dx)]);
        }
        InfillPattern::CrossHatch => raw = crosshatch_fill(inp),
        InfillPattern::Honeycomb => raw = honeycomb_fill(inp),
        InfillPattern::Honeycomb3d => raw = honeycomb3d_fill(inp),
        InfillPattern::Gyroid => match inp.gyroid_layer_height {
            Some(lh) => {
                let mm = [bbox[0] / SCALE, bbox[1] / SCALE, bbox[2] / SCALE, bbox[3] / SCALE];
                raw = crate::tpms::gyroid_optimized(spacing_mm, density * 2.44, lh, z_mm, mm)
                    .into_iter()
                    .map(|l| {
                        simplify_open(
                            l.iter().map(|q| pt(q[0] * SCALE, q[1] * SCALE)).collect(),
                            0.04 * SCALE,
                        )
                    })
                    .collect();
            }
            None => raw = gyroid_waves(spacing_mm, density, z_mm, bbox),
        },
        InfillPattern::TpmsD | InfillPattern::TpmsFk => {
            let mm = [bbox[0] / SCALE, bbox[1] / SCALE, bbox[2] / SCALE, bbox[3] / SCALE];
            let lines = if pattern == InfillPattern::TpmsD {
                crate::tpms::diamond(spacing_mm, density, z_mm, mm)
            } else {
                crate::tpms::fischer_koch(spacing_mm, density, z_mm, mm)
            };
            // The Fischer-Koch rings are simplified to 0.04 mm (`SPARSE_INFILL_RESOLUTION`); either fill's
            // lines lose their collinear points.
            let tol = if pattern == InfillPattern::TpmsFk {
                0.04
            } else {
                0.002
            };
            raw = lines
                .into_iter()
                .map(|l| {
                    let pts: Vec<Pt> = l.iter().map(|q| pt(q[0] * SCALE, q[1] * SCALE)).collect();
                    simplify_open(pts, tol * SCALE)
                })
                .collect();
        }
        _ => raw.extend(lines(
            std::f64::consts::FRAC_PI_4 + std::f64::consts::FRAC_PI_2 * f64::from(layer % 2),
            pitch_of(1.0),
            0.0,
            bbox,
        )),
    }
    let support = Support::new(region);
    let min = (w_mm * MIN_PIECE * SCALE).m_powi(2);
    let mut out: Vec<Vec<Point>> = Vec::new();
    // The space filling curves come cut to the region already (their ends lie on its edge, where a second
    // cut would take the end pieces off).
    let curve = matches!(
        pattern,
        InfillPattern::HilbertCurve | InfillPattern::ArchimedeanChords | InfillPattern::OctagramSpiral
    );
    for path in raw {
        let cut = if curve {
            vec![path]
        } else {
            inside_pieces(&path, &support)
        };
        for piece in cut {
            let (Some(a), Some(z)) = (piece.first(), piece.last()) else {
                continue;
            };
            let d2 =
                (f64::from(z.x) - f64::from(a.x)).m_powi(2) + (f64::from(z.y) - f64::from(a.y)).m_powi(2);
            // The gyroid drops pieces shorter than 0.8 spacing along the curve; the others keep any that
            // span half a line width.
            let keep = if matches!(
                pattern,
                InfillPattern::Gyroid
                    | InfillPattern::Honeycomb3d
                    | InfillPattern::CrossHatch
                    | InfillPattern::TpmsD
                    | InfillPattern::TpmsFk
            ) {
                let len: f64 = piece
                    .windows(2)
                    .map(|w| match w {
                        [p, q] => (f64::from(q.x) - f64::from(p.x)).m_hypot(f64::from(q.y) - f64::from(p.y)),
                        _ => 0.0,
                    })
                    .sum();
                len >= 0.8 * spacing_mm * SCALE
            } else {
                piece.len() > 2 || d2 >= min
            };
            if keep {
                out.push(piece.iter().map(|p| Point::new(p.x, p.y)).collect());
            }
        }
    }
    let line_based = matches!(
        pattern,
        InfillPattern::Triangles
            | InfillPattern::Stars
            | InfillPattern::Cubic
            | InfillPattern::QuarterCubic
            | InfillPattern::LateralLattice
            | InfillPattern::LateralHoneycomb
            | InfillPattern::CrossHatch
            | InfillPattern::Rectilinear
            | InfillPattern::Grid
            | InfillPattern::Gyroid
            | InfillPattern::Honeycomb
            | InfillPattern::Honeycomb3d
            | InfillPattern::TpmsD
            | InfillPattern::TpmsFk
    );
    // The space filling curves are only chained when dense (`density > 0.5`), as in Orca.
    let plane = matches!(
        pattern,
        InfillPattern::HilbertCurve | InfillPattern::ArchimedeanChords | InfillPattern::OctagramSpiral
    );
    if connect_mm > 0.0 && (line_based || (plane && density <= 0.5)) {
        let params = crate::anchor::Params {
            spacing: spacing_mm,
            anchor: anchor_mm,
            anchor_max: connect_mm,
        };
        // The lines of the multi-sweep patterns end on the region pulled in half a spacing, which is the
        // boundary Orca joins them along; the other patterns were given that region already.
        out = if is_multiline(pattern) {
            crate::anchor::connect(out, &contracted(inp), params)
        } else {
            crate::anchor::connect(out, region, params)
        };
    }
    // Orca simplifies every fill path to the G-code resolution (0.0125 mm, `Layer.cpp`) once it is made; the
    // curves of the minimal surface fills have many points to give.
    if matches!(pattern, InfillPattern::TpmsD | InfillPattern::TpmsFk) {
        out = out
            .into_iter()
            .map(|p| {
                let pts: Vec<Pt> = p.iter().map(|q| Pt::new(q.x, q.y)).collect();
                simplify_open(pts, 0.0125 * SCALE)
                    .into_iter()
                    .map(|q| Point::new(q.x, q.y))
                    .collect()
            })
            .collect();
    }
    out
}

/// The parts of `path` inside `support`. Each vertex is tested directly, so a
/// vertex that lands exactly on the boundary cannot flip the state; crossings
/// only place the cuts.
fn inside_pieces(path: &[Pt], support: &Support) -> Vec<Vec<Pt>> {
    let Some(&first) = path.first() else {
        return Vec::new();
    };
    let mut state = support.inside(first);
    let mut pieces: Vec<Vec<Pt>> = Vec::new();
    let mut cur: Vec<Pt> = if state { vec![first] } else { Vec::new() };
    let mut hits: Vec<(f64, Pt)> = Vec::new();
    for w in path.windows(2) {
        let [a, b] = w else { continue };
        let b_in = support.inside(*b);
        support.crossings(*a, *b, &mut hits);
        let mut st = state;
        for &(_, x) in &hits {
            if st {
                cur.push(x);
                if cur.len() >= 2 {
                    pieces.push(std::mem::take(&mut cur));
                }
                cur.clear();
            } else {
                cur = vec![x];
            }
            st = !st;
        }
        if st != b_in {
            // A touch or a coincident edge: the state changes at b.
            if st && cur.len() >= 2 {
                pieces.push(std::mem::take(&mut cur));
            }
            cur = if b_in { vec![*b] } else { Vec::new() };
        } else if st {
            cur.push(*b);
        }
        state = b_in;
    }
    if state && cur.len() >= 2 {
        pieces.push(cur);
    }
    pieces
}

/// Support lines: parallel lines at a fixed `angle_deg`, `pitch_mm` apart on the plate's
/// grid, cut to `region` shrunk by half a line width, and, with `edge_rows`, one more
/// row along each edge of the region (as `OrcaSlicer` prints supports). Neighboring
/// lines are joined along the edge when the gap is at most `connect_mm`. The rows are
/// anchored at `center_mm`, the plate's middle.
pub(crate) fn support_lines(
    region: &Shapes,
    w_mm: f64,
    pitch_mm: f64,
    angle_deg: f64,
    edge_rows: bool,
    connect_mm: f64,
    center_mm: [f64; 2],
) -> Vec<Vec<Point>> {
    if edge_rows && region.len() > 1 {
        // Each island has rows along its own edges (Orca fills support one island at a time).
        return region
            .iter()
            .flat_map(|island| {
                support_lines(
                    &vec![island.clone()],
                    w_mm,
                    pitch_mm,
                    angle_deg,
                    true,
                    connect_mm,
                    center_mm,
                )
            })
            .collect();
    }
    let inner = perimeters::offset(region, -((w_mm / 2.0 * SCALE) as i32));
    let Some(b) = perimeters::bounds(&inner) else {
        return Vec::new();
    };
    let angle = angle_deg.to_radians();
    let (sn, cs) = angle.m_sin_cos();
    let pitch = pitch_mm * SCALE;
    let m = 2.0 * SCALE;
    let bbox = [
        f64::from(b[0]) - m,
        f64::from(b[1]) - m,
        f64::from(b[2]) + m,
        f64::from(b[3]) + m,
    ];
    // Range across the lines of the region itself.
    let (mut vmin, mut vmax) = (f64::MAX, f64::MIN);
    for p in inner.iter().flat_map(|s| s.iter()).flat_map(|r| r.iter()) {
        let v = -f64::from(p.x) * sn + f64::from(p.y) * cs;
        vmin = vmin.min(v);
        vmax = vmax.max(v);
    }
    // Rows sit on a grid anchored at the middle of the plate.
    let phase = (-center_mm[0] * sn + center_mm[1] * cs) * SCALE;
    let mut rows: Vec<f64> = lines(angle, pitch, phase, bbox)
        .iter()
        .filter_map(|l| {
            let p = l.first()?;
            Some(-f64::from(p.x) * sn + f64::from(p.y) * cs)
        })
        .filter(|v| *v > vmin && *v < vmax)
        .collect();
    if edge_rows {
        let nudge = 0.02 * SCALE;
        for v in [vmin + nudge, vmax - nudge] {
            if rows.iter().all(|r| (r - v).abs() > 0.25 * w_mm * SCALE) {
                rows.push(v);
            }
        }
    }
    rows.sort_by(f64::total_cmp);
    let (mut u0, mut u1) = (f64::MAX, f64::MIN);
    for (x, y) in [
        (bbox[0], bbox[1]),
        (bbox[2], bbox[1]),
        (bbox[2], bbox[3]),
        (bbox[0], bbox[3]),
    ] {
        let u = x * cs + y * sn;
        u0 = u0.min(u);
        u1 = u1.max(u);
    }
    let support = Support::new(&inner);
    let mut raw: Vec<Vec<Point>> = Vec::new();
    for (i, v) in rows.iter().enumerate() {
        let (a, z) = (
            pt(u0 * cs - v * sn, u0 * sn + v * cs),
            pt(u1 * cs - v * sn, u1 * sn + v * cs),
        );
        let path = if i % 2 == 0 { vec![a, z] } else { vec![z, a] };
        raw.extend(
            inside_pieces(&path, &support)
                .into_iter()
                .map(|piece| piece.iter().map(|p| Point::new(p.x, p.y)).collect::<Vec<_>>()),
        );
    }
    if connect_mm > 0.0 {
        let params = crate::anchor::Params {
            spacing: w_mm,
            anchor: 0.0,
            anchor_max: connect_mm,
        };
        raw = crate::anchor::connect(raw, &inner, params);
    }
    raw
}

#[allow(clippy::cast_possible_truncation, reason = "results are plate coordinates")]
fn pt(x: f64, y: f64) -> Pt {
    Pt::new(x.round() as i32, y.round() as i32)
}

/// Orca's `FillRectilinear::fill_surface_by_multilines`: for each sweep `(angle_base, shift)` (radians, mm),
/// lines `spacing / (density / sweeps)` apart at the layer's infill angle plus the base angle, on a lattice
/// that passes through the center of the objects moved by `shift`, cut to the region pulled in half a
/// spacing. The infill angle plus a right angle (`_infill_direction`); these fills do not turn per layer.
fn contracted(inp: &SparseIn<'_>) -> Shapes {
    let c = perimeters::offset(inp.region, -crate::geom::mm(0.5 * inp.spacing_mm));
    if c.is_empty() { inp.region.clone() } else { c }
}

fn multilines(inp: &SparseIn<'_>, sweeps: &[(f64, f64)]) -> Vec<Vec<Pt>> {
    use std::f64::consts::FRAC_PI_2;
    let spacing = inp.spacing_mm;
    let ls = spacing / (inp.density / sweeps.len().max(1) as f64);
    let contracted = contracted(inp);
    let Some(b) = perimeters::bounds(inp.region) else {
        return Vec::new();
    };
    let (lo, hi) = (
        [f64::from(b[0]) / SCALE, f64::from(b[1]) / SCALE],
        [f64::from(b[2]) / SCALE, f64::from(b[3]) / SCALE],
    );
    let rings: Vec<Vec<[f64; 2]>> = contracted
        .iter()
        .flat_map(|sh| sh.iter())
        .map(|r| {
            r.iter()
                .map(|p| [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE])
                .collect()
        })
        .collect();
    // These fills keep one angle on every layer (`_layer_angle` is 0 for them).
    let base = inp.angle_deg.to_radians() + FRAC_PI_2;
    let mut out: Vec<Vec<Pt>> = Vec::new();
    for &(angle_base, shift) in sweeps {
        let angle = base + angle_base;
        let (s, c) = angle.m_sin_cos();
        // The region's box in the frame turned by -angle, where the lines are vertical.
        let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for (x, y) in [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])] {
            let (u, v) = (x * c + y * s, -x * s + y * c);
            x0 = x0.min(u);
            x1 = x1.max(u);
            y0 = y0.min(v);
            y1 = y1.max(v);
        }
        let center = [
            f64::midpoint(inp.object[0], inp.object[2]),
            f64::midpoint(inp.object[1], inp.object[3]),
        ];
        let mut refx = center[0] * c + center[1] * s;
        let m = shift % ls;
        refx -= if m >= 0.0 { m } else { ls + m };
        let margin = spacing + 1e-4;
        let (k0, k1) = (
            ((x0 + margin - refx) / ls).ceil() as i64,
            ((x1 - margin - refx) / ls).floor() as i64,
        );
        // The region in the turned frame.
        let turned: Vec<Vec<[f64; 2]>> = rings
            .iter()
            .map(|r| {
                r.iter()
                    .map(|p| [p[0] * c + p[1] * s, -p[0] * s + p[1] * c])
                    .collect()
            })
            .collect();
        for k in k0..=k1 {
            let x = refx + k as f64 * ls;
            // Where the vertical line at x crosses the region: edges that straddle x, the half open rule so a
            // vertex on the line counts once.
            let mut ys: Vec<f64> = Vec::new();
            for r in &turned {
                let n = r.len();
                for i in 0..n {
                    let (Some(a), Some(b)) = (r.get(i), r.get((i + 1) % n)) else {
                        continue;
                    };
                    if (a[0] > x) != (b[0] > x) {
                        ys.push(a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]));
                    }
                }
            }
            ys.sort_by(f64::total_cmp);
            for &[lo_y, hi_y] in ys.as_chunks::<2>().0 {
                let rot = |v: f64| pt((x * c - v * s) * SCALE, (x * s + v * c) * SCALE);
                if hi_y - lo_y > 1e-6 {
                    out.push(vec![rot(lo_y), rot(hi_y)]);
                }
            }
        }
    }
    out
}

/// Orca's `FillLine`: lines `spacing / density` apart at the infill angle (turning 90 degrees on odd layers),
/// every second one slanted by the gap between the spacing and the line width so that neighbors can be joined
/// end to end, each island on its own. The pieces inside the island (pulled out by 0.02 mm) are lengthened by
/// 0.3 spacing, chained nearest end first, and a piece starts where the previous one ended when the gap across
/// is one line spacing (give or take the slant) and the joining segment stays inside the island grown half a
/// spacing.
fn line_fill(inp: &SparseIn<'_>) -> Vec<Vec<Pt>> {
    use std::f64::consts::FRAC_PI_2;
    let spacing = inp.spacing_mm;
    let ls = spacing / inp.density;
    let osc = if inp.density > 0.9999 { 0.0 } else { ls - spacing };
    let alt = if inp.layer % 2 == 1 && !inp.fixed_angle {
        FRAC_PI_2
    } else {
        0.0
    };
    let angle = inp.angle_deg.to_radians() + alt + FRAC_PI_2;
    let (sn, cs) = angle.m_sin_cos();
    let rot_back = |u: f64, v: f64| pt((u * cs - v * sn) * SCALE, (u * sn + v * cs) * SCALE);
    let mut out: Vec<Vec<Pt>> = Vec::new();
    for island in inp.region {
        let shape: Shapes = vec![island.clone()];
        let rings: Vec<Vec<[f64; 2]>> = island
            .iter()
            .map(|r| {
                r.iter()
                    .map(|p| [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE])
                    .collect()
            })
            .collect();
        let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for p in rings.first().into_iter().flatten() {
            let (u, v) = (p[0] * cs + p[1] * sn, -p[0] * sn + p[1] * cs);
            x0 = x0.min(u);
            x1 = x1.max(u);
            y0 = y0.min(v);
            y1 = y1.max(v);
        }
        if x0 > x1 {
            continue;
        }
        let center = [
            f64::midpoint(inp.object[0], inp.object[2]),
            f64::midpoint(inp.object[1], inp.object[3]),
        ];
        let refx = center[0] * cs + center[1] * sn;
        let k0 = ((x0 - refx) / ls).floor() as i64;
        let clip = Support::new(&perimeters::offset(&shape, crate::geom::mm(0.02)));
        let extra = 0.3 * spacing;
        let mut pieces: Vec<Vec<Pt>> = Vec::new();
        let mut k = k0;
        while refx + k as f64 * ls <= x1 + 1e-4 {
            let x = refx + k as f64 * ls;
            let o = if (k - k0) % 2 == 1 { osc } else { 0.0 };
            let (a, b) = (rot_back(x - o, y0), rot_back(x + o, y1));
            for mut piece in inside_pieces(&[a, b], &clip) {
                // Lengthen along the turned y: the lower end down, the upper end up.
                let back = |p: &Pt| {
                    let (px, py) = (f64::from(p.x) / SCALE, f64::from(p.y) / SCALE);
                    (px * cs + py * sn, -px * sn + py * cs)
                };
                if let (Some(f), Some(l)) = (piece.first().map(back), piece.last().map(back)) {
                    let up = l.1 >= f.1;
                    let (fi, li) = (if up { -extra } else { extra }, if up { extra } else { -extra });
                    if let Some(p) = piece.first_mut() {
                        *p = rot_back(f.0, f.1 + fi);
                    }
                    if let Some(p) = piece.last_mut() {
                        *p = rot_back(l.0, l.1 + li);
                    }
                }
                pieces.push(piece);
            }
            k += 1;
        }
        // Nearest end first, from the first piece.
        let mut ordered: Vec<Vec<Pt>> = Vec::new();
        let mut rest = pieces;
        if rest.is_empty() {
            continue;
        }
        ordered.push(rest.remove(0));
        while !rest.is_empty() {
            let Some(end) = ordered.last().and_then(|p| p.last()).copied() else {
                break;
            };
            let d = |p: &Pt| (f64::from(p.x) - f64::from(end.x)).m_hypot(f64::from(p.y) - f64::from(end.y));
            let best = rest
                .iter()
                .enumerate()
                .flat_map(|(i, p)| {
                    [
                        (i, false, p.first().map_or(f64::MAX, d)),
                        (i, true, p.last().map_or(f64::MAX, d)),
                    ]
                })
                .min_by(|a, b| a.2.total_cmp(&b.2));
            let Some((i, rev, _)) = best else { break };
            let mut p = rest.remove(i);
            if rev {
                p.reverse();
            }
            ordered.push(p);
        }
        // Join pieces whose gap is one line spacing across and the segment lies inside.
        let inside = Support::new(&perimeters::offset(&shape, crate::geom::mm(0.5 * spacing)));
        let tol = 0.01 * 10.0 * 1e-4; // 10 scaled epsilons, mm
        let mut joined: Vec<Vec<Pt>> = Vec::new();
        for p in ordered {
            let join = joined.last().zip(p.first()).is_some_and(|(prev, &first)| {
                let Some(&last) = prev.last() else { return false };
                let (dx, dy) = {
                    let (a, b) = (
                        (f64::from(last.x) - f64::from(first.x)) / SCALE,
                        (f64::from(last.y) - f64::from(first.y)) / SCALE,
                    );
                    // Across and along the lines.
                    ((a * cs + b * sn).abs(), (-a * sn + b * cs).abs())
                };
                let mut hits = Vec::new();
                inside.crossings(last, first, &mut hits);
                dx >= (ls - osc) - tol
                    && dx <= ls + osc + tol
                    && dy <= 2.0 * ls
                    && hits.is_empty()
                    && inside.inside(last)
            });
            if join && let Some(prev) = joined.last_mut() {
                prev.extend(p);
            } else {
                joined.push(p);
            }
        }
        out.extend(joined);
    }
    out
}

/// Orca's `FillHoneycomb`: hexagon columns, each island on its own: the island's box turned by the layer's
/// angle about the hexagon center, grown to the lattice (columns `2 * distance` wide, rows three sides
/// high), a zigzag polyline per pair of columns, turned back. The angle is the infill angle, plus 60
/// degrees for every layer modulo three (`_layer_angle`), plus a right angle.
fn honeycomb_fill(inp: &SparseIn<'_>) -> Vec<Vec<Pt>> {
    use std::f64::consts::FRAC_PI_2;
    let min_spacing = inp.spacing_mm;
    let distance = min_spacing / inp.density;
    let hex_side = distance / (3.0_f64.sqrt() / 2.0);
    let hex_width = distance * 2.0;
    let pattern_height = hex_side * 3.0;
    let y_short = distance * 3.0_f64.sqrt() / 3.0;
    let x_offset = min_spacing / 2.0;
    let y_offset = x_offset * 3.0_f64.sqrt() / 3.0;
    let center = [hex_width / 2.0, hex_side];
    let angle = inp.angle_deg.to_radians()
        + if inp.fixed_angle {
            0.0
        } else {
            std::f64::consts::FRAC_PI_3 * f64::from(inp.layer % 3)
        }
        + FRAC_PI_2;
    let (sn, cs) = angle.m_sin_cos();
    // Turning by `a` about the hexagon center.
    let turn = |p: [f64; 2], a: f64| -> [f64; 2] {
        let (s, c) = a.m_sin_cos();
        let (dx, dy) = (p[0] - center[0], p[1] - center[1]);
        [center[0] + dx * c - dy * s, center[1] + dx * s + dy * c]
    };
    let _ = (sn, cs);
    let mut out: Vec<Vec<Pt>> = Vec::new();
    for island in inp.region {
        let Some(contour) = island.first() else { continue };
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        let (mut blo, mut bhi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in contour {
            let q = [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE];
            blo = [blo[0].min(q[0]), blo[1].min(q[1])];
            bhi = [bhi[0].max(q[0]), bhi[1].max(q[1])];
        }
        for corner in [
            [blo[0], blo[1]],
            [bhi[0], blo[1]],
            [bhi[0], bhi[1]],
            [blo[0], bhi[1]],
        ] {
            let t = turn(corner, angle);
            lo = [lo[0].min(t[0]), lo[1].min(t[1])];
            hi = [hi[0].max(t[0]), hi[1].max(t[1])];
        }
        if lo[0] > hi[0] {
            continue;
        }
        // Grown to the lattice.
        lo = [
            lo[0].min((lo[0] / hex_width).floor() * hex_width),
            lo[1].min((lo[1] / pattern_height).floor() * pattern_height),
        ];
        let mut x = lo[0];
        while x <= hi[0] {
            let mut pts: Vec<[f64; 2]> = Vec::new();
            let mut ax = [x + x_offset, x + distance - x_offset];
            for _ in 0..2 {
                // The first column is turned upside down before the second is added.
                pts.reverse();
                let mut y = lo[1];
                while y <= hi[1] {
                    pts.push([ax[1], y + y_offset]);
                    pts.push([ax[0], y + y_short - y_offset]);
                    pts.push([ax[0], y + y_short + hex_side + y_offset]);
                    pts.push([ax[1], y + y_short + hex_side + y_short - y_offset]);
                    pts.push([ax[1], y + y_short + hex_side + y_short + hex_side + y_offset]);
                    y += y_short + hex_side + y_short + hex_side;
                }
                ax = [ax[0] + distance, ax[1] + distance];
                ax.swap(0, 1);
                x += distance;
            }
            out.push(simplify_open(
                pts.into_iter()
                    .map(|p| {
                        let t = turn(p, -angle);
                        pt(t[0] * SCALE, t[1] * SCALE)
                    })
                    .collect(),
                0.002 * SCALE,
            ));
        }
    }
    out
}

/// Orca's `Fill3DHoneycomb` (David Eccles' truncated octahedron): per island, in the frame turned by the
/// infill angle, columns (or rows, by height) of a triangular-ish wave whose amplitude follows the height,
/// on a lattice of `gridSize` anchored at the grid of four modules. `Zpos` is the layer's z scaled to make
/// the layer count per module whole. Lengths in mm.
fn honeycomb3d_fill(inp: &SparseIn<'_>) -> Vec<Vec<Pt>> {
    let spacing = inp.spacing_mm;
    let density = inp.density;
    let mut z_scale = 2.0_f64.sqrt();
    let mut grid = spacing * f64::midpoint(z_scale, 1.0) / density;
    let layer_height = 1.0;
    let mut per_module = ((grid * 2.0) / (z_scale * layer_height) + 0.05).floor();
    if density > 0.42 {
        per_module = 2.0;
        grid = spacing * 1.1 / density;
        z_scale = (grid * 2.0) / (per_module * layer_height);
    } else {
        per_module = per_module.max(2.0);
        z_scale = (grid * 2.0) / (per_module * layer_height);
        grid = spacing * f64::midpoint(z_scale, 1.0) / density;
        per_module = ((grid * 2.0) / (z_scale * layer_height) + 0.05).floor().max(2.0);
        z_scale = (grid * 2.0) / (per_module * layer_height);
    }
    let zpos = inp.z_mm * z_scale;
    let angle = inp.angle_deg.to_radians();
    let (sn, cs) = angle.m_sin_cos();
    let tri_wave = |pos: f64| -> f64 {
        let mut t = pos / (grid * 2.0) + 0.25;
        t -= t.trunc();
        (1.0 - (t * 8.0 - 4.0).abs()) * (grid / 4.0) + grid / 4.0
    };
    let sgn = |v: f64| -> f64 { f64::from(i32::from(v > 0.0) - i32::from(v < 0.0)) };
    let trout_wave = |pos: f64| -> f64 {
        let perp_offset = tri_wave(zpos) / 2.0;
        let y = tri_wave(pos);
        if y.abs() > perp_offset.abs() {
            sgn(y) * perp_offset
        } else {
            y * sgn(perp_offset)
        }
    };
    let crit: Vec<f64> = {
        let norm = (tri_wave(zpos) / 2.0).abs() / grid;
        let mut v = vec![0.0];
        if norm > 0.0 {
            v.extend([
                grid * norm,
                grid * (1.0 - norm),
                grid * (1.0 + norm),
                grid * (2.0 - norm),
            ]);
        }
        v
    };
    let colinear = |length: f64| -> Vec<f64> {
        let mut pts = vec![0.0];
        let mut c = 0.0;
        while c < length {
            for p in &crit {
                pts.push(c + p);
            }
            c += grid * 2.0;
        }
        pts.push(length);
        pts
    };
    let perpend = |length: f64, base: f64, dir: f64| -> Vec<f64> {
        let mut pts = vec![base];
        let mut c = 0.0;
        while c < length {
            for p in &crit {
                pts.push(base + trout_wave(*p) * dir);
            }
            c += grid * 2.0;
        }
        pts.push(base);
        pts
    };
    let turn = |x: f64, y: f64, a: f64| -> (f64, f64) {
        let (s, c) = a.m_sin_cos();
        (x * c - y * s, x * s + y * c)
    };
    let _ = (sn, cs);
    let mut out: Vec<Vec<Pt>> = Vec::new();
    for island in inp.region {
        let Some(contour) = island.first() else { continue };
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in contour {
            let (u, v) = turn(f64::from(p.x) / SCALE, f64::from(p.y) / SCALE, -angle);
            lo = [lo[0].min(u), lo[1].min(v)];
            hi = [hi[0].max(u), hi[1].max(v)];
        }
        if lo[0] > hi[0] {
            continue;
        }
        let margin = 5.0 * spacing;
        let g4 = grid * 4.0;
        let origin = [
            ((lo[0] / g4).floor() * g4).min(lo[0]) - margin,
            ((lo[1] / g4).floor() * g4).min(lo[1]) - margin,
        ];
        let (bw, bh) = (
            (hi[0] + margin - origin[0]).trunc(),
            (hi[1] + margin - origin[1]).trunc(),
        );
        let vertical = (zpos + grid / 2.0).rem_euclid(grid * 2.0) / (grid * 2.0) < 0.5;
        let mut polylines: Vec<Vec<(f64, f64)>> = Vec::new();
        if vertical {
            let mut dir = -1.0;
            let mut x = 0.0;
            while x <= bw {
                let xs = perpend(bh, x, dir);
                let ys = colinear(bh);
                let mut pts: Vec<(f64, f64)> = xs.into_iter().zip(ys).collect();
                if dir > 0.0 {
                    pts.reverse();
                }
                polylines.push(pts);
                x += grid;
                dir = -dir;
            }
        } else {
            let mut dir = 1.0;
            let mut y = grid;
            while y <= bh {
                let xs = colinear(bw);
                let ys = perpend(bw, y, dir);
                let mut pts: Vec<(f64, f64)> = xs.into_iter().zip(ys).collect();
                if dir < 0.0 {
                    pts.reverse();
                }
                polylines.push(pts);
                y += grid;
                dir = -dir;
            }
        }
        for pl in polylines {
            // Orca simplifies to five line widths in scaled units, which only drops collinear points.
            out.push(simplify_open(
                pl.into_iter()
                    .map(|(u, v)| {
                        let (x, y) = turn(u + origin[0], v + origin[1], angle);
                        pt(x * SCALE, y * SCALE)
                    })
                    .collect(),
                0.002 * SCALE,
            ));
        }
    }
    out
}

/// Douglas-Peucker on an open polyline: drops points within `tol` (internal units) of the chord kept.
fn simplify_open(pts: Vec<Pt>, tol: f64) -> Vec<Pt> {
    let n = pts.len();
    if n < 3 {
        return pts;
    }
    let mut keep = vec![false; n];
    if let Some(k) = keep.first_mut() {
        *k = true;
    }
    if let Some(k) = keep.last_mut() {
        *k = true;
    }
    let mut stack = vec![(0usize, n - 1)];
    while let Some((lo, hi)) = stack.pop() {
        let (Some(a), Some(b)) = (pts.get(lo), pts.get(hi)) else {
            continue;
        };
        let (dx, dy) = (f64::from(b.x) - f64::from(a.x), f64::from(b.y) - f64::from(a.y));
        let len = dx.m_hypot(dy);
        let mut worst = (0.0_f64, lo);
        for i in lo + 1..hi {
            let Some(p) = pts.get(i) else { continue };
            let (px, py) = (f64::from(p.x) - f64::from(a.x), f64::from(p.y) - f64::from(a.y));
            let d = if len > 0.0 {
                (px * dy - py * dx).abs() / len
            } else {
                px.m_hypot(py)
            };
            if d > worst.0 {
                worst = (d, i);
            }
        }
        if worst.0 > tol {
            if let Some(k) = keep.get_mut(worst.1) {
                *k = true;
            }
            stack.push((lo, worst.1));
            stack.push((worst.1, hi));
        }
    }
    pts.into_iter()
        .zip(keep)
        .filter_map(|(p, k)| k.then_some(p))
        .collect()
}

/// Orca's `FillCrossHatch` (Bambu's): per island, in the frame turned by the infill angle, lines that keep
/// one direction for a stretch of layers ("repeat" layers), then change into the other direction over a
/// few "transform" layers in which each line bends into a wave whose amplitude follows the height. The
/// lattice is `spacing / density` (1.08 times that below 99.9 percent) and anchored at four lattice
/// modules. Lengths in mm.
fn crosshatch_fill(inp: &SparseIn<'_>) -> Vec<Vec<Pt>> {
    let spacing = inp.spacing_mm;
    let density = inp.density;
    let mut grid = spacing / density;
    if density < 0.999 {
        grid *= 1.08;
    }
    let repeat_ratio = if density < 0.3 {
        (1.0 - (-5.0 * density).m_exp()).clamp(0.2, 1.0)
    } else {
        1.0
    };
    let angle = inp.angle_deg.to_radians();
    let turn = |x: f64, y: f64, a: f64| -> (f64, f64) {
        let (s, c) = a.m_sin_cos();
        (x * c - y * s, x * s + y * c)
    };
    // Lines across the box: `direction` < 0 is vertical.
    let repeat = |direction: i32, width: f64, height: f64| -> Vec<Vec<(f64, f64)>> {
        let (w, h) = if direction < 0 {
            (height, width)
        } else {
            (width, height)
        };
        let n = (h / grid) as i64 + 1;
        (0..n)
            .map(|i| {
                let (a, b) = ((0.0, grid * i as f64), (w, grid * i as f64));
                if direction < 0 {
                    vec![(a.1, a.0), (b.1, b.0)]
                } else {
                    vec![a, b]
                }
            })
            .collect()
    };
    let transform = |progress: f64, direction: i32, width: f64, height: f64| -> Vec<Vec<(f64, f64)>> {
        let g2 = grid * 2.0;
        let off = progress / 8.0 * g2;
        let cycle = [
            (0.25 * g2 - off, off),
            (0.25 * g2 + off, off),
            (0.75 * g2 - off, -off),
            (0.75 * g2 + off, -off),
        ];
        let (w, h) = if direction < 0 {
            (height, width)
        } else {
            (width, height)
        };
        let cycles = (w / g2) as i64 + 2;
        let lines = (h / g2) as i64 + 2;
        let odd: Vec<(f64, f64)> = (0..cycles)
            .flat_map(|i| cycle.iter().map(move |p| (p.0 + i as f64 * g2, p.1)))
            .collect();
        let mut out: Vec<Vec<(f64, f64)>> = Vec::new();
        for i in 0..lines {
            out.push(odd.iter().map(|p| (p.0, p.1 + g2 * i as f64)).collect());
        }
        for i in 0..lines {
            out.push(
                odd.iter()
                    .map(|p| (p.0 - 0.5 * g2, p.1 + (i as f64 + 0.5) * g2))
                    .collect(),
            );
        }
        if direction < 0 {
            for pl in &mut out {
                for p in pl.iter_mut() {
                    *p = (p.1, p.0);
                }
            }
        }
        out
    };
    let layers = |width: f64, height: f64| -> Vec<Vec<(f64, f64)>> {
        let trans_size = grid * 0.4;
        let repeat_size = grid * repeat_ratio;
        let z = inp.z_mm + repeat_size / 2.0 + trans_size;
        let period = trans_size + repeat_size;
        let remains = z - (z / period).floor() * period;
        let trans_z = remains - repeat_size;
        let direction = if z.rem_euclid(period * 2.0) <= period {
            -1
        } else {
            1
        };
        if trans_z < 0.0 {
            repeat(direction, width, height)
        } else {
            let progress = trans_z.rem_euclid(trans_size) / trans_size;
            if progress < 0.5 {
                transform((progress + 0.1) * 2.0, direction, width, height)
            } else {
                transform((1.1 - progress) * 2.0, -direction, width, height)
            }
        }
    };
    let mut out: Vec<Vec<Pt>> = Vec::new();
    for island in inp.region {
        let Some(contour) = island.first() else { continue };
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in contour {
            let (u, v) = turn(f64::from(p.x) / SCALE, f64::from(p.y) / SCALE, -angle);
            lo = [lo[0].min(u), lo[1].min(v)];
            hi = [hi[0].max(u), hi[1].max(v)];
        }
        if lo[0] > hi[0] {
            continue;
        }
        let g4 = grid * 4.0;
        let origin = [
            ((lo[0] / g4).floor() * g4).min(lo[0]),
            ((lo[1] / g4).floor() * g4).min(lo[1]),
        ];
        for pl in layers(hi[0] - origin[0], hi[1] - origin[1]) {
            out.push(
                pl.into_iter()
                    .map(|(u, v)| {
                        let (x, y) = turn(u + origin[0], v + origin[1], angle);
                        pt(x * SCALE, y * SCALE)
                    })
                    .collect(),
            );
        }
    }
    out
}

/// Parallel lines at `angle` covering `bbox`, `pitch` apart, the first at
/// offset `phase` from the origin's line, in serpentine order.
#[allow(clippy::cast_possible_truncation, reason = "line counts are small")]
fn lines(angle: f64, pitch: f64, phase: f64, bbox: [f64; 4]) -> Vec<Vec<Pt>> {
    let (s, c) = angle.m_sin_cos();
    // u along the line, v across it.
    let corners = [
        (bbox[0], bbox[1]),
        (bbox[2], bbox[1]),
        (bbox[2], bbox[3]),
        (bbox[0], bbox[3]),
    ];
    let (mut u0, mut u1, mut v0, mut v1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for (x, y) in corners {
        let (u, v) = (x * c + y * s, -x * s + y * c);
        u0 = u0.min(u);
        u1 = u1.max(u);
        v0 = v0.min(v);
        v1 = v1.max(v);
    }
    let k0 = ((v0 - phase) / pitch).ceil() as i64;
    let k1 = ((v1 - phase) / pitch).floor() as i64;
    let mut out = Vec::new();
    for (row, k) in (k0..=k1).enumerate() {
        let v = phase + k as f64 * pitch;
        let (a, b) = (
            pt(u0 * c - v * s, u0 * s + v * c),
            pt(u1 * c - v * s, u1 * s + v * c),
        );
        out.push(if row % 2 == 0 { vec![a, b] } else { vec![b, a] });
    }
    out
}

/// The gyroid's waves as Orca draws them (`FillGyroid.cpp`, `make_gyroid_waves`): not the zero surface of
/// the 3D field, but two families of curves `y = f(x)` (or `x = f(y)` on layers where the vertical family
/// is the smoother one), one every pi of the parameter, each wave a period of `2 pi` in it. The parameter is
/// the distance over `spacing / (2.44 * density)` and the height over the same, so a layer of the stack
/// shifts the phase. The lattice is anchored at the plate's origin less ten spacings, as Orca's grid
/// alignment and bounding box margin do, so every layer and island shares it. `bbox` in internal units.
fn gyroid_waves(spacing_mm: f64, density: f64, z_mm: f64, bbox: [f64; 4]) -> Vec<Vec<Pt>> {
    use std::f64::consts::{FRAC_PI_2, PI};
    let dens = (density * 2.44).max(1e-6);
    let scale = spacing_mm / dens; // mm per unit of the wave parameter
    let tol = (spacing_mm / 2.0).min(0.2) / scale;
    let z = z_mm / scale;
    let (z_sin, z_cos) = z.m_sin_cos();
    let sqr = |v: f64| v * v;
    let f = |x: f64, vertical: bool, flip: bool| -> f64 {
        if vertical {
            let phase = (if z_cos < 0.0 { PI } else { 0.0 }) + PI;
            let a = (x + phase).m_sin();
            let b = -z_cos;
            let res = z_sin * (x + phase + if flip { PI } else { 0.0 }).m_cos();
            let r = (sqr(a) + sqr(b)).sqrt();
            (a / r).m_asin() + (res / r).m_asin() + PI
        } else {
            let phase = if z_sin < 0.0 { PI } else { 0.0 };
            let a = (x + phase).m_cos();
            let b = -z_sin;
            let res = z_cos * (x + phase + if flip { 0.0 } else { PI }).m_sin();
            let r = (sqr(a) + sqr(b)).sqrt();
            (a / r).m_asin() + (res / r).m_asin() + 0.5 * PI
        }
    };
    let one_period = |width: f64, vertical: bool, flip: bool| -> Vec<[f64; 2]> {
        let limit = (2.0 * PI).min(width);
        let mut pts: Vec<[f64; 2]> = Vec::new();
        let mut x = 0.0;
        while x < limit - 1e-4 {
            pts.push([x, f(x, vertical, flip)]);
            x += FRAC_PI_2;
        }
        pts.push([limit, f(limit, vertical, flip)]);
        loop {
            let size = pts.len();
            for i in 1..size {
                let (Some(lp), Some(rp)) = (pts.get(i - 1).copied(), pts.get(i).copied()) else {
                    continue;
                };
                let x = lp[0] + (rp[0] - lp[0]) / 2.0;
                let ip = [x, f(x, vertical, flip)];
                let cross = (ip[0] - lp[0]) * (ip[1] - rp[1]) - (ip[1] - lp[1]) * (ip[0] - rp[0]);
                if cross.abs() > sqr(tol) {
                    pts.push(ip);
                }
            }
            if size == pts.len() {
                break;
            }
            crate::sorting::sort_by(&mut pts, |a, b| a[0].total_cmp(&b[0]));
        }
        pts
    };
    let wave = |period: &[[f64; 2]],
                width: f64,
                height: f64,
                offset: f64,
                vertical: bool,
                flip: bool|
     -> Vec<[f64; 2]> {
        let mut pts: Vec<[f64; 2]> = period.to_vec();
        let p = pts.last().map_or(2.0 * PI, |l| l[0]);
        #[allow(clippy::float_cmp, reason = "a width set to exactly one truncated period")]
        if width != p {
            pts.pop();
            let n = pts.len();
            while let Some(src) = pts.get(pts.len() - n).copied() {
                pts.push([src[0] + p, src[1]]);
                if pts.last().is_none_or(|l| l[0] >= width - 1e-4) {
                    break;
                }
            }
            pts.push([width, f(width, vertical, flip)]);
        }
        pts.into_iter()
            .map(|mut q| {
                q[1] = (q[1] + offset).clamp(0.0, height);
                if vertical {
                    q.swap(0, 1);
                }
                q
            })
            .collect()
    };
    // The lattice origin and the parameter box over the bounding box.
    let g = 2.0 * PI * scale;
    let (minx, miny, maxx, maxy) = (bbox[0] / SCALE, bbox[1] / SCALE, bbox[2] / SCALE, bbox[3] / SCALE);
    let margin = 10.0 * spacing_mm;
    let (ox, oy) = ((minx / g).floor() * g - margin, (miny / g).floor() * g - margin);
    let (mut width, mut height) = (
        ((maxx - ox) / scale).ceil() + 1.0,
        ((maxy - oy) / scale).ceil() + 1.0,
    );
    let vertical = z_sin.abs() <= z_cos.abs();
    let (mut lower, mut upper, mut flip) = (0.0, height, true);
    if vertical {
        flip = false;
        lower = -PI;
        upper = width - FRAC_PI_2;
        std::mem::swap(&mut width, &mut height);
    }
    let odd = one_period(width, vertical, flip);
    let even = one_period(width, vertical, !flip);
    let to_pt = |q: [f64; 2]| pt((q[0] * scale + ox) * SCALE, (q[1] * scale + oy) * SCALE);
    let mut out: Vec<Vec<Pt>> = Vec::new();
    let mut y0 = lower;
    while y0 < upper + 1e-4 {
        // Both families are written with the flip of the even one, as Orca toggles it before the loop.
        out.push(
            wave(&odd, width, height, y0, vertical, !flip)
                .into_iter()
                .map(to_pt)
                .collect(),
        );
        y0 += PI;
        if y0 < upper + 1e-4 {
            out.push(
                wave(&even, width, height, y0, vertical, !flip)
                    .into_iter()
                    .map(to_pt)
                    .collect(),
            );
        }
        y0 += PI;
    }
    out
}

/// Loops of the region shrunk by `pitch_mm` again and again until nothing is left.
#[allow(clippy::cast_possible_truncation, reason = "pitch is a few millimeters")]
fn concentric(region: &Shapes, pitch_mm: f64, spacing_mm: f64) -> Vec<Vec<Point>> {
    // Orca's `FillConcentric`: the surface (already pulled in half a spacing) is the first loop, each next
    // loop is the last shrunk by the pitch plus half a spacing and grown back half a spacing (which drops
    // slivers), until nothing is left.
    let (step, half) = (
        (pitch_mm * SCALE).round() as i32,
        (spacing_mm / 2.0 * SCALE).round() as i32,
    );
    if step <= 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cur: Shapes = region.clone();
    let mut last_total = f64::MAX;
    for _ in 0..400 {
        let mut total = 0.0;
        let mut rings: Vec<Vec<Point>> = Vec::new();
        for ring in cur.iter().flat_map(|s| s.iter()) {
            let Some(first) = ring.first() else { continue };
            total += ring
                .iter()
                .zip(ring.iter().cycle().skip(1))
                .map(|(a, b)| f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y)))
                .sum::<f64>();
            let mut pts: Vec<Point> = ring.iter().map(|p| Point::new(p.x, p.y)).collect();
            pts.push(Point::new(first.x, first.y));
            rings.push(pts);
        }
        // Nothing left, or an offset that no longer shrinks (a safety for odd shapes).
        if rings.is_empty() || total >= last_total {
            break;
        }
        out.append(&mut rings);
        last_total = total;
        cur = perimeters::offset(&perimeters::offset(&cur, -(step + half)), half);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_in(pattern: InfillPattern, region: &Shapes, density: f64, z_mm: f64, layer: u32) -> SparseIn<'_> {
        SparseIn {
            pattern,
            region,
            w_mm: 0.42,
            spacing_mm: 0.42,
            density,
            z_mm,
            layer,
            connect_mm: 0.0,
            anchor_mm: 0.0,
            object: [0.0, 0.0, 100.0, 100.0],
            angle_deg: 45.0,
            lateral_angles: [-45.0, 45.0],
            overhang_angle_deg: 60.0,
            fixed_angle: false,
            gyroid_layer_height: None,
        }
    }

    fn square(mm: f64) -> Shapes {
        let s = (mm * SCALE) as i32;
        vec![vec![vec![
            Pt::new(0, 0),
            Pt::new(s, 0),
            Pt::new(s, s),
            Pt::new(0, s),
        ]]]
    }

    fn length_mm(paths: &[Vec<Point>]) -> f64 {
        paths
            .iter()
            .flat_map(|p| p.windows(2))
            .map(|w| match w {
                [a, b] => a.dist_mm(*b),
                _ => 0.0,
            })
            .sum()
    }

    #[test]
    fn every_pattern_hits_its_density() {
        // Line length per area should be density / width, within a tolerance the pattern allows. The 3D
        // honeycomb is left out: its line length follows the height, and `path_parity.py` checks it
        // against Orca.
        let region = square(60.0);
        let want = 0.2 / 0.42 * 3600.0;
        let mut bad = Vec::new();
        for (p, tol, boost) in [
            (InfillPattern::Line, 0.05, 1.0),
            (InfillPattern::Triangles, 0.08, 1.0),
            (InfillPattern::Stars, 0.1, 1.0),
            (InfillPattern::Cubic, 0.08, 1.0),
            (InfillPattern::CrossHatch, 0.08, 1.0),
            (InfillPattern::Honeycomb, 0.1, 1.32),
            (InfillPattern::Gyroid, 0.15, 1.0),
            (InfillPattern::TpmsD, 0.3, 1.0),
            (InfillPattern::OctagramSpiral, 0.05, 1.0),
            (InfillPattern::HilbertCurve, 0.05, 1.0),
            (InfillPattern::ArchimedeanChords, 0.05, 1.0),
            (InfillPattern::TpmsFk, 0.35, 1.0),
            (InfillPattern::Concentric, 0.15, 1.0),
        ] {
            let got = length_mm(&sparse(&test_in(p, &region, 0.2, 3.0, 5)));
            let want = want * boost;
            if (got - want).abs() / want >= tol {
                bad.push(format!("{p:?}: {got:.0} mm vs {want:.0} mm"));
            }
        }
        assert!(bad.is_empty(), "{bad:?}");
    }

    #[test]
    fn patterns_stay_inside_the_region() {
        let region = square(30.0);
        let max = (30.0 * SCALE) as i32;
        for p in [
            InfillPattern::Triangles,
            InfillPattern::Gyroid,
            InfillPattern::TpmsD,
            InfillPattern::TpmsFk,
            InfillPattern::Honeycomb,
            InfillPattern::Concentric,
        ] {
            for path in sparse(&test_in(p, &region, 0.15, 1.0, 0)) {
                assert!(
                    path.iter()
                        .all(|q| q.x >= -2 && q.y >= -2 && q.x <= max + 2 && q.y <= max + 2),
                    "{p:?}"
                );
            }
        }
    }

    #[test]
    fn a_grid_in_a_square_joins_into_one_stroke() {
        // Every line end has a short arc to the line that crosses it near the wall and a longer arc to the
        // next pair, and the short arcs tie. Following the short arcs closes loops, so the order of the ties
        // decided how many strokes were left: four on the block where Orca prints one.
        let mut strokes = Vec::new();
        for (side, layer) in [(38.06, 10), (38.06, 11), (30.0, 4), (45.0, 7), (60.0, 2)] {
            let region = square(side);
            let inp = SparseIn {
                connect_mm: 20.0,
                anchor_mm: 1.5,
                ..test_in(InfillPattern::Grid, &region, 0.15, 2.0, layer)
            };
            strokes.push((side, layer, sparse(&inp).len()));
        }
        assert!(strokes.iter().all(|s| s.2 == 1), "{strokes:?}");
    }

    #[test]
    fn layers_differ_where_the_pattern_moves_with_height() {
        let region = square(40.0);
        let a = sparse(&test_in(InfillPattern::Cubic, &region, 0.2, 1.0, 5));
        let b = sparse(&test_in(InfillPattern::Cubic, &region, 0.2, 1.2, 6));
        assert_ne!(a, b);
        assert_eq!(a, sparse(&test_in(InfillPattern::Cubic, &region, 0.2, 1.0, 5)));
    }
}
