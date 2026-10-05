// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The two minimal-surface sparse infills, TPMS-D (Schwarz diamond) and TPMS-FK (Fischer-Koch S). Both
//! cut a surface of constant phase out of a periodic field at the layer's height; the layers stack into
//! a lattice with no flat regions. Own implementation after the way Orca's `FillTpmsD.cpp` and
//! `FillTpmsFK.cpp` set the problem up (period from spacing and density, the field anchored to the plate's
//! coordinates so every layer and island shares it).
//!
//! TPMS-D solves `sin x sin y sin z = cos x cos y cos z` for one curve per layer by a parametric walk,
//! TPMS-FK traces the zero level of the field on a grid of 0.4 mm cells with marching squares.

#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    reason = "grid and count arithmetic on small values"
)]

use crate::fm::Fm as _;
use std::f64::consts::PI;

/// Density factor of the diamond, which gives its curves the weight of other patterns at equal density.
const D_DENSITY_ADJUST: f64 = 2.1;
/// Largest deviation of a refined curve piece from the curve, mm.
const D_TOLERANCE_MM: f64 = 0.1;
/// Pieces one period of the diamond curve starts with, before refining.
const D_INITIAL_SEGMENTS: usize = 16;

/// The Schwarz diamond lines of one layer over `bbox` (`[min_x, min_y, max_x, max_y]`, mm), as polylines in mm.
/// `z_mm` is the layer's print height.
pub(crate) fn diamond(spacing_mm: f64, density: f64, z_mm: f64, bbox: [f64; 4]) -> Vec<Vec<[f64; 2]>> {
    let dens = (density * D_DENSITY_ADJUST).max(1e-6);
    // mm per unit of the field's phase.
    let scale = spacing_mm / dens;
    let grid = 2.0 * PI * scale;
    // The box is aligned down to a multiple of one period of the lattice.
    let (ox, oy) = ((bbox[0] / grid).floor() * grid, (bbox[1] / grid).floor() * grid);
    let width = ((bbox[2] - ox) / scale).ceil() + 1.0;
    let height = ((bbox[3] - oy) / scale).ceil() + 1.0;
    let tolerance = (spacing_mm / 2.0).min(D_TOLERANCE_MM) / scale;
    let z = z_mm / scale;
    // sin x sin y sin z - cos x cos y cos z = 0 becomes a cos(x - y) = b cos(x + y) with u = x - y, v = x + y.
    let mut a = z.m_sin() - z.m_cos();
    let mut b = z.m_sin() + z.m_cos();
    let (mut min_u, mut max_u) = (-height, width);
    let (mut min_v, mut max_v) = (0.0, width + height);
    // Where |b| < |a|, v = acos(b / a cos u) is a continuous curve of u; otherwise u and v swap roles.
    let swap = a.abs() > b.abs();
    if swap {
        std::mem::swap(&mut a, &mut b);
        std::mem::swap(&mut min_u, &mut min_v);
        std::mem::swap(&mut max_u, &mut max_v);
    }
    let v_of = |u: f64| (a / b * u.m_cos()).clamp(-1.0, 1.0).m_acos();
    // One period of the curve, refined where a chord strays from it, then repeated across the box.
    let mut wave: Vec<(f64, f64)> = Vec::new();
    for c in 0..=D_INITIAL_SEGMENTS {
        let u = min_u + 2.0 * PI * c as f64 / D_INITIAL_SEGMENTS as f64;
        wave.push((u, v_of(u)));
    }
    let mut cur = 0;
    while cur + 1 < wave.len() {
        let (Some(&(u1, v1)), Some(&(u2, v2))) = (wave.get(cur), wave.get(cur + 1)) else {
            break;
        };
        let mid_u = f64::midpoint(u1, u2);
        let mid_v = v_of(mid_u);
        if (mid_v - f64::midpoint(v1, v2)).abs() > tolerance {
            wave.insert(cur + 1, (mid_u, mid_v));
        } else {
            cur += 1;
        }
    }
    // The points of one period come again a period later, until the box is covered (the first point of a
    // period is the last of the one before).
    let mut c = 1;
    while c < wave.len() && wave.last().is_some_and(|l| l.0 < max_u) {
        let Some(&(u, v)) = wave.get(c) else { break };
        wave.push((u + 2.0 * PI, v));
        c += 1;
    }
    let mut out: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut shift = (min_v / (2.0 * PI)).floor() * 2.0 * PI;
    while shift < max_v + 2.0 * PI {
        for forward in [false, true] {
            out.push(
                wave.iter()
                    .map(|&(u, v)| {
                        let v = if forward { v } else { -v } + shift;
                        let x = f64::midpoint(u, v);
                        let y = (v - u) / 2.0 * if swap { -1.0 } else { 1.0 };
                        [x * scale + ox, y * scale + oy]
                    })
                    .collect(),
            );
        }
        shift += 2.0 * PI;
    }
    out
}

/// Cell of the marching squares grid, mm.
const FK_CELL_MM: f64 = 0.4;
/// Raster pixel along a cell edge where the zero crossing is placed, mm.
const FK_PIXEL_MM: f64 = 0.004;
/// Period of the Fischer-Koch field per spacing at full density.
const FK_PERIOD: f64 = 4.18;

/// The Fischer-Koch S field at a point, scaled by the frequency.
fn fk_field(freq: f32, x: f64, y: f64, z: f64) -> f32 {
    let (fx, fy, fz) = (freq * x as f32, freq * y as f32, freq * z as f32);
    (2.0 * fx).m_cos() * fy.m_sin() * fz.m_cos()
        + (2.0 * fy).m_cos() * fz.m_sin() * fx.m_cos()
        + (2.0 * fz).m_cos() * fx.m_sin() * fy.m_cos()
}

/// Directions a line leaves a marching squares cell by: bit 0 left, 1 down, 2 right, 3 up.
const LEFT: u8 = 0b0001;
const DOWN: u8 = 0b0010;
const RIGHT: u8 = 0b0100;
const UP: u8 = 0b1000;

/// The exits of a cell from its corner tags a (top left), b (bottom left), c (bottom right), d (top right):
/// a line crosses an edge that goes from an unset corner to a set one, walking a, b, c, d.
#[allow(clippy::fn_params_excessive_bools, reason = "the four corner tags of a cell")]
fn exits(a: bool, b: bool, c: bool, d: bool) -> u8 {
    let mut m = 0;
    if !a && b {
        m |= LEFT;
    }
    if !b && c {
        m |= DOWN;
    }
    if !c && d {
        m |= RIGHT;
    }
    if !d && a {
        m |= UP;
    }
    m
}

/// The Fischer-Koch S lines of one layer over `bbox` (mm), polylines in mm, `period_density` being the
/// density capped at 0.9.
pub(crate) fn fischer_koch(spacing_mm: f64, density: f64, z_mm: f64, bbox: [f64; 4]) -> Vec<Vec<[f64; 2]>> {
    let density_factor = density.clamp(1e-6, 0.9);
    let period = FK_PERIOD * spacing_mm / density_factor;
    let freq = (2.0 * PI / period) as f32;
    // The box grows by two spacings so the lines do not end at its edge.
    let m = 2.0 * spacing_mm;
    let (ox, oy) = (bbox[0] - m, bbox[1] - m);
    let (w, h) = (bbox[2] - bbox[0] + 2.0 * m, bbox[3] - bbox[1] + 2.0 * m);
    march(|x, y| fk_field(freq, x, y, z_mm), [ox, oy], [w, h])
}

/// The gyroid field `sin(fx x) cos(fy y) + sin(fy y) cos(fz z) + sin(fz z) cos(fx x)` (single precision, as Orca
/// computes it).
fn gyroid_field(f: [f32; 3], x: f64, y: f64, z: f64) -> f32 {
    let (a, b, c) = (f[0] * x as f32, f[1] * y as f32, f[2] * z as f32);
    a.m_sin() * b.m_cos() + b.m_sin() * c.m_cos() + c.m_sin() * a.m_cos()
}

/// `gyroid_optimized` (Orca 2.4.2 Fill/FillGyroid.cpp, the marching squares branch): the zero level of the
/// gyroid field with the period along Z shortened by `omega` = `sqrt(1 / density_adjusted) / sqrt(1 + layer
/// height / spacing)`, clamped to 1 to 2, so the strands that carry Z loads are shorter columns at low density;
/// the period across the layer is the plain gyroid's, so the filament stays about the same. `density_adjusted`
/// is the density times 2.44; `bbox` (mm) is the island's box, widened to the gyroid's grid and by ten spacings
/// as Orca does. Rings in mm.
pub(crate) fn gyroid_optimized(
    spacing_mm: f64,
    density_adjusted: f64,
    layer_height: f64,
    z_mm: f64,
    bbox: [f64; 4],
) -> Vec<Vec<[f64; 2]>> {
    let lh_ratio = if spacing_mm > 0.0 {
        layer_height / spacing_mm
    } else {
        0.5
    };
    let omega = ((1.0 / density_adjusted.max(0.1)).sqrt() / (1.0 + lh_ratio).sqrt()).clamp(1.0, 2.0);
    let period = (2.0 * PI) as f32 * spacing_mm as f32 / (density_adjusted as f32).max(0.001);
    let base = (2.0 * PI) as f32 / period.max(1e-3);
    let f = [base, base, omega as f32 * base];
    let g = 2.0 * PI * spacing_mm / density_adjusted.max(1e-6);
    let margin = 10.0 * spacing_mm;
    let (ox, oy) = (
        (bbox[0] / g).floor() * g - margin,
        (bbox[1] / g).floor() * g - margin,
    );
    march(
        |x, y| gyroid_field(f, x, y, z_mm),
        [ox, oy],
        [bbox[2] + margin - ox, bbox[3] + margin - oy],
    )
}

/// The zero level of `field` over the box at `origin` of `size` (mm), traced with marching squares on a grid of
/// 0.4 mm cells and placed on 0.004 mm pixels (Orca's `marchsq` with its raster); closed rings in mm.
#[allow(clippy::too_many_lines, reason = "one tracing pass")]
fn march(field: impl Fn(f64, f64) -> f32, origin: [f64; 2], size: [f64; 2]) -> Vec<Vec<[f64; 2]>> {
    let [ox, oy] = origin;
    let [w, h] = size;
    let (cols, rows) = ((w / FK_PIXEL_MM).floor() as i64, (h / FK_PIXEL_MM).floor() as i64);
    let win = (FK_CELL_MM / FK_PIXEL_MM).round() as i64;
    if rows <= 0 || cols <= 0 || win <= 0 {
        return Vec::new();
    }
    let at = |r: i64, c: i64| -> f32 { field(ox + c as f64 * FK_PIXEL_MM, oy + r as f64 * FK_PIXEL_MM) };
    // The grid has a one cell border that stays clear, so every line closes into a ring.
    let (grows, gcols) = (2 + rows / win, 2 + cols / win);
    let tag = |gr: i64, gc: i64| -> bool {
        let (r, c) = ((gr - 1) * win, (gc - 1) * win);
        r >= 0 && r < rows && c >= 0 && c < cols && at(r, c) > 0.0
    };
    let mut tags = vec![false; (grows * gcols) as usize];
    for gr in 0..grows {
        for gc in 0..gcols {
            if let Some(t) = tags.get_mut((gr * gcols + gc) as usize) {
                *t = tag(gr, gc);
            }
        }
    }
    let tag_at = |gr: i64, gc: i64| -> bool {
        gr >= 0
            && gr < grows
            && gc >= 0
            && gc < gcols
            && tags.get((gr * gcols + gc) as usize).copied().unwrap_or(false)
    };
    let mut dirs = vec![0_u8; (grows * gcols) as usize];
    for gr in 0..grows {
        for gc in 0..gcols {
            if let Some(d) = dirs.get_mut((gr * gcols + gc) as usize) {
                *d = exits(
                    tag_at(gr, gc),
                    tag_at(gr + 1, gc),
                    tag_at(gr + 1, gc + 1),
                    tag_at(gr, gc + 1),
                );
            }
        }
    }
    let len = dirs.len();
    // The next direction out of a cell, the way the line came in deciding an ambiguous cell.
    let next_dir = |dirs: &[u8], idx: usize, prev: u8| -> u8 {
        match dirs.get(idx).copied().unwrap_or(0) {
            d if d == LEFT | RIGHT => {
                if prev == UP {
                    LEFT
                } else {
                    RIGHT
                }
            }
            d if d == UP | DOWN => {
                if prev == RIGHT {
                    UP
                } else {
                    DOWN
                }
            }
            d => d,
        }
    };
    let step = |idx: usize, d: u8| -> usize {
        match d {
            LEFT => idx.wrapping_sub(1),
            DOWN => idx + gcols as usize,
            RIGHT => idx + 1,
            UP => idx.wrapping_sub(gcols as usize),
            _ => idx,
        }
    };
    // Rings of (cell, exit) in the order of the scan.
    let mut rings: Vec<Vec<(usize, u8)>> = Vec::new();
    let mut start = 0;
    loop {
        while start < len && dirs.get(start).copied().unwrap_or(0) == 0 {
            start += 1;
        }
        if start >= len {
            break;
        }
        let mut ring: Vec<(usize, u8)> = Vec::new();
        let mut idx = start;
        let mut next = next_dir(&dirs, idx, 0);
        loop {
            if next == 0 || idx >= len {
                break;
            }
            ring.push((idx, next));
            if let Some(d) = dirs.get_mut(idx) {
                *d &= !next;
            }
            idx = step(idx, next);
            next = next_dir(&dirs, idx, next);
            if idx == start {
                break;
            }
        }
        if ring.len() > 1 {
            rings.push(ring);
        }
    }
    // The crossing on an exit edge: the first pixel along it, from the unset corner to the set one, where the
    // field is no longer below zero (a binary search over the edge's pixels).
    let cross = |idx: usize, d: u8| -> [f64; 2] {
        let (gr, gc) = ((idx as i64) / gcols, (idx as i64) % gcols);
        let (tr, tc) = ((gr - 1) * win, (gc - 1) * win);
        // Start corner, per pixel step (dr, dc), and the shift of the answer.
        let (r0, c0, dr, dc) = match d {
            LEFT => (tr, tc, 1, 0),
            DOWN => (tr + win, tc, 0, 1),
            RIGHT => (tr + win, tc + win, -1, 0),
            _ => (tr, tc + win, 0, -1),
        };
        let clamp = |v: i64, hi: i64| v.clamp(0, hi);
        let (fr, fc) = (clamp(r0, rows - 1), clamp(c0, cols - 1));
        // One pixel past the end corner, so the corner itself is a candidate.
        let (er, ec) = (clamp(r0 + dr * (win + 1), rows), clamp(c0 + dc * (win + 1), cols));
        let count = ((er - fr).abs() + (ec - fc).abs()).max(0);
        let (mut first, mut n) = (0_i64, count);
        while n > 0 {
            let s = n / 2;
            let (r, c) = (fr + dr * (first + s), fc + dc * (first + s));
            if at(r.clamp(0, rows - 1), c.clamp(0, cols - 1)) < 0.0 {
                first += s + 1;
                n -= s + 1;
            } else {
                n = s;
            }
        }
        let (mut r, mut c) = (fr + dr * first, fc + dc * first);
        // Points on the bottom and right sides move out by a pixel.
        if d == RIGHT {
            r += 1;
        } else if d == UP {
            c += 1;
        }
        [ox + c as f64 * FK_PIXEL_MM, oy + r as f64 * FK_PIXEL_MM]
    };
    rings
        .iter()
        .map(|ring| {
            let mut pts: Vec<[f64; 2]> = ring.iter().map(|&(idx, d)| cross(idx, d)).collect();
            if let Some(&f) = pts.first() {
                pts.push(f);
            }
            pts
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn length(lines: &[Vec<[f64; 2]>]) -> f64 {
        lines
            .iter()
            .flat_map(|l| l.windows(2))
            .map(|w| match w {
                [a, b] => (a[0] - b[0]).m_hypot(a[1] - b[1]),
                _ => 0.0,
            })
            .sum()
    }

    /// Length of the curves inside a square of `side` mm at the origin.
    fn inside(lines: &[Vec<[f64; 2]>], side: f64) -> f64 {
        let mut total = 0.0;
        for l in lines {
            for w in l.windows(2) {
                if let [a, b] = w {
                    let m = [f64::midpoint(a[0], b[0]), f64::midpoint(a[1], b[1])];
                    if (0.0..side).contains(&m[0]) && (0.0..side).contains(&m[1]) {
                        total += (a[0] - b[0]).m_hypot(a[1] - b[1]);
                    }
                }
            }
        }
        total
    }

    #[test]
    fn the_diamond_lines_satisfy_the_equation() {
        let lines = diamond(0.45, 0.2, 3.7, [0.0, 0.0, 30.0, 30.0]);
        assert!(!lines.is_empty());
        let scale = 0.45 / (0.2 * D_DENSITY_ADJUST);
        let z = 3.7 / scale;
        let mut worst = 0.0_f64;
        for p in lines.iter().flatten() {
            let (x, y) = (p[0] / scale, p[1] / scale);
            let f = x.m_sin() * y.m_sin() * z.m_sin() - x.m_cos() * y.m_cos() * z.m_cos();
            worst = worst.max(f.abs());
        }
        // Pieces are chords of the curve, so the residual stays under the refinement tolerance.
        assert!(worst < 0.2, "{worst}");
    }

    #[test]
    fn both_fills_hit_about_the_density() {
        // Line length per area is density over the line width, within what the shape of the field allows.
        let want = 0.2 / 0.45 * 900.0;
        let d = inside(&diamond(0.45, 0.2, 3.0, [0.0, 0.0, 30.0, 30.0]), 30.0);
        assert!((d - want).abs() / want < 0.25, "diamond {d:.0} against {want:.0}");
        let f = inside(&fischer_koch(0.45, 0.2, 3.0, [0.0, 0.0, 30.0, 30.0]), 30.0);
        assert!(
            (f - want).abs() / want < 0.35,
            "fischer-koch {f:.0} against {want:.0}"
        );
    }

    #[test]
    fn the_field_is_anchored_to_the_plate_not_the_box() {
        // A smaller box sees the same lines.
        let big = fischer_koch(0.45, 0.15, 2.0, [0.0, 0.0, 40.0, 40.0]);
        let small = fischer_koch(0.45, 0.15, 2.0, [10.0, 10.0, 20.0, 20.0]);
        let (a, b) = (inside(&big, 20.0) - inside(&big, 10.0), 0.0);
        assert!(a > 0.0 && b == 0.0 && length(&small) > 0.0);
        let near = |p: [f64; 2], lines: &[Vec<[f64; 2]>]| {
            lines.iter().flat_map(|l| l.windows(2)).any(|w| match w {
                [s, e] => {
                    let (dx, dy) = (e[0] - s[0], e[1] - s[1]);
                    let len2 = dx * dx + dy * dy;
                    let t = if len2 > 0.0 {
                        (((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / len2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    (p[0] - (s[0] + t * dx)).m_hypot(p[1] - (s[1] + t * dy)) < 0.05
                }
                _ => false,
            })
        };
        let mut checked = 0;
        for l in &small {
            for p in l {
                if (12.0..18.0).contains(&p[0]) && (12.0..18.0).contains(&p[1]) {
                    assert!(near(*p, &big), "{p:?}");
                    checked += 1;
                }
            }
        }
        assert!(checked > 10, "{checked}");
    }
}
