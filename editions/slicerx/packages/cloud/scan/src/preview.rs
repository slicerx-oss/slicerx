// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The preview image: a small software render of the model from a fixed
//! three-quarter view.
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    clippy::similar_names,
    clippy::too_many_lines,
    reason = "pixel and vector math on small bounded images"
)]

use sx_core::mesh::Mesh;

use crate::png;

type V3 = [f32; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt();
    if l > 0.0 {
        [a[0] / l, a[1] / l, a[2] / l]
    } else {
        a
    }
}

/// Bounding-box pixel tests the rasterizer may spend on one preview. A
/// hostile mesh of huge overlapping triangles cannot make it run longer.
const PIXEL_BUDGET: u64 = 120_000_000;
const SUPERSAMPLE: usize = 2;
const BASE: [f32; 3] = [189.0, 147.0, 249.0];

/// Renders the mesh from a fixed three-quarter view with flat shading and
/// returns a `size` by `size` PNG with a transparent background.
pub fn preview_png(mesh: &Mesh, size: u32) -> Vec<u8> {
    let side = size as usize * SUPERSAMPLE;
    let mut color = vec![[0.0_f32; 3]; side * side];
    let mut depth = vec![f32::NEG_INFINITY; side * side];
    let mut hit = vec![false; side * side];

    let az = (-40.0_f32).to_radians();
    let el = 30.0_f32.to_radians();
    let d = [el.cos() * az.cos(), el.cos() * az.sin(), el.sin()];
    let r = norm(cross([0.0, 0.0, 1.0], d));
    let u = cross(d, r);
    let light = norm([
        d[0] * 0.7 - r[0] * 0.5 + u[0] * 0.5,
        d[1] * 0.7 - r[1] * 0.5 + u[1] * 0.5,
        d[2] * 0.7 - r[2] * 0.5 + u[2] * 0.5,
    ]);

    let project = |p: V3| [dot(p, r), dot(p, u), dot(p, d)];
    let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
    for part in &mesh.parts {
        for &p in &part.positions {
            let q = project(p);
            for k in 0..2 {
                lo[k] = lo[k].min(q[k]);
                hi[k] = hi[k].max(q[k]);
            }
        }
    }
    let span = (hi[0] - lo[0]).max(hi[1] - lo[1]).max(f32::EPSILON);
    let margin = 0.06 * side as f32;
    let scale = (side as f32 - 2.0 * margin) / span;
    let to_px = |q: V3| {
        [
            (q[0] - lo[0]) * scale + margin + (side as f32 - 2.0 * margin - (hi[0] - lo[0]) * scale) / 2.0,
            side as f32
                - ((q[1] - lo[1]) * scale
                    + margin
                    + (side as f32 - 2.0 * margin - (hi[1] - lo[1]) * scale) / 2.0),
            q[2],
        ]
    };

    let mut budget = PIXEL_BUDGET;
    'parts: for part in &mesh.parts {
        for t in &part.triangles {
            let (Some(&a), Some(&b), Some(&c)) = (
                part.positions.get(t[0] as usize),
                part.positions.get(t[1] as usize),
                part.positions.get(t[2] as usize),
            ) else {
                continue;
            };
            let mut n = norm(cross(sub(b, a), sub(c, a)));
            if dot(n, d) < 0.0 {
                n = [-n[0], -n[1], -n[2]];
            }
            let shade = 0.30 + 0.70 * dot(n, light).max(0.0);
            let (pa, pb, pc) = (to_px(project(a)), to_px(project(b)), to_px(project(c)));
            let area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
            if area.abs() < 1e-6 {
                continue;
            }
            let x0 = pa[0].min(pb[0]).min(pc[0]).floor().max(0.0) as usize;
            let x1 = (pa[0].max(pb[0]).max(pc[0]).ceil().max(0.0) as usize).min(side - 1);
            let y0 = pa[1].min(pb[1]).min(pc[1]).floor().max(0.0) as usize;
            let y1 = (pa[1].max(pb[1]).max(pc[1]).ceil().max(0.0) as usize).min(side - 1);
            if x0 > x1 || y0 > y1 {
                continue;
            }
            let cost = ((x1 - x0 + 1) * (y1 - y0 + 1)) as u64;
            if cost > budget {
                break 'parts;
            }
            budget -= cost;
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                    let w0 = ((pb[0] - px) * (pc[1] - py) - (pb[1] - py) * (pc[0] - px)) / area;
                    let w1 = ((pc[0] - px) * (pa[1] - py) - (pc[1] - py) * (pa[0] - px)) / area;
                    let w2 = 1.0 - w0 - w1;
                    if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                        continue;
                    }
                    let z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
                    let i = y * side + x;
                    if let (Some(zb), Some(cb), Some(hb)) =
                        (depth.get_mut(i), color.get_mut(i), hit.get_mut(i))
                        && z > *zb
                    {
                        *zb = z;
                        *cb = [BASE[0] * shade, BASE[1] * shade, BASE[2] * shade];
                        *hb = true;
                    }
                }
            }
        }
    }

    let out = size as usize;
    let mut rgba = vec![0u8; out * out * 4];
    let samples = (SUPERSAMPLE * SUPERSAMPLE) as f32;
    for y in 0..out {
        for x in 0..out {
            let (mut sum, mut cover) = ([0.0_f32; 3], 0.0_f32);
            for sy in 0..SUPERSAMPLE {
                for sx in 0..SUPERSAMPLE {
                    let i = (y * SUPERSAMPLE + sy) * side + x * SUPERSAMPLE + sx;
                    if hit.get(i).copied().unwrap_or(false)
                        && let Some(c) = color.get(i)
                    {
                        for k in 0..3 {
                            sum[k] += c[k];
                        }
                        cover += 1.0;
                    }
                }
            }
            if cover > 0.0
                && let Some(px) = rgba.get_mut((y * out + x) * 4..(y * out + x) * 4 + 4)
            {
                for k in 0..3 {
                    px[k] = (sum[k] / cover).round().clamp(0.0, 255.0) as u8;
                }
                px[3] = (255.0 * cover / samples).round() as u8;
            }
        }
    }
    png::encode_rgba(size, size, &rgba)
}
