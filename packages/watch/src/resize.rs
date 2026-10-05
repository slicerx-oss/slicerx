// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Cropping and scaling frames. The resampler is a separable triangle (bilinear) filter widened
//! by the scale factor when shrinking, the same method as Pillow's `resize(BILINEAR)`, which the
//! SigLIP2 image processor uses. Matching it keeps the model's scores within rounding of the
//! scores it was evaluated with.
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "pixel counts and sizes are far below 2^52, and every float is clamped to the target range before it is cast"
)]
use crate::decode::Rgb;

/// The part of `rgb` inside a box in frame coordinates from 0 to 1 (left, top, right, bottom),
/// at least one pixel.
pub fn crop(rgb: &Rgb, bbox: [f64; 4]) -> Rgb {
    let [left, top, right, bottom] = bbox.map(|v| v.clamp(0.0, 1.0));
    let px = |v: f64, max: u32| (v * f64::from(max)).round().clamp(0.0, f64::from(max)) as u32;
    let (x0, y0) = (px(left, rgb.width), px(top, rgb.height));
    let x1 = px(right, rgb.width).max(x0 + 1).min(rgb.width);
    let y1 = px(bottom, rgb.height).max(y0 + 1).min(rgb.height);
    let (x0, y0) = (x0.min(x1.saturating_sub(1)), y0.min(y1.saturating_sub(1)));
    let (cw, ch) = (x1 - x0, y1 - y0);
    let row = rgb.width as usize * 3;
    let mut data = Vec::with_capacity(cw as usize * ch as usize * 3);
    for y in y0..y1 {
        let start = y as usize * row + x0 as usize * 3;
        if let Some(s) = rgb.data.get(start..start + cw as usize * 3) {
            data.extend_from_slice(s);
        }
    }
    Rgb {
        width: cw,
        height: ch,
        data,
    }
}

/// Weights for one output position: the first input index and the normalized weights.
fn coefficients(input: usize, output: usize) -> Vec<(usize, Vec<f64>)> {
    let scale = input as f64 / output as f64;
    let filter_scale = scale.max(1.0);
    let support = filter_scale; // the triangle filter's support is 1
    (0..output)
        .map(|o| {
            let center = (o as f64 + 0.5) * scale;
            let lo = ((center - support + 0.5).floor().max(0.0)) as usize;
            let hi = ((center + support + 0.5).floor() as usize).min(input);
            let mut w: Vec<f64> = (lo..hi)
                .map(|i| {
                    let x = (i as f64 - center + 0.5) / filter_scale;
                    (1.0 - x.abs()).max(0.0)
                })
                .collect();
            let sum: f64 = w.iter().sum();
            if sum > 0.0 {
                for v in &mut w {
                    *v /= sum;
                }
            }
            (lo, w)
        })
        .collect()
}

fn to_byte(v: f64) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

/// Scales an interleaved picture with `channels` bytes per pixel to `out_w` by `out_h`.
pub fn resize(
    src: &[u8],
    width: usize,
    height: usize,
    channels: usize,
    out_w: usize,
    out_h: usize,
) -> Vec<u8> {
    if width == 0 || height == 0 || out_w == 0 || out_h == 0 || src.len() < width * height * channels {
        return vec![0; out_w * out_h * channels];
    }
    // Horizontal pass, rounded to bytes like Pillow's 8-bit path, then vertical.
    let hx = coefficients(width, out_w);
    let mut mid = vec![0u8; out_w * height * channels];
    for y in 0..height {
        for (ox, (lo, w)) in hx.iter().enumerate() {
            for c in 0..channels {
                let v: f64 = w
                    .iter()
                    .enumerate()
                    .map(|(k, wk)| {
                        wk * f64::from(
                            src.get(((y * width) + lo + k) * channels + c)
                                .copied()
                                .unwrap_or(0),
                        )
                    })
                    .sum();
                if let Some(d) = mid.get_mut((y * out_w + ox) * channels + c) {
                    *d = to_byte(v);
                }
            }
        }
    }
    let vy = coefficients(height, out_h);
    let mut out = vec![0u8; out_w * out_h * channels];
    for (oy, (lo, w)) in vy.iter().enumerate() {
        for x in 0..out_w {
            for c in 0..channels {
                let v: f64 = w
                    .iter()
                    .enumerate()
                    .map(|(k, wk)| {
                        wk * f64::from(
                            mid.get(((lo + k) * out_w + x) * channels + c)
                                .copied()
                                .unwrap_or(0),
                        )
                    })
                    .sum();
                if let Some(d) = out.get_mut((oy * out_w + x) * channels + c) {
                    *d = to_byte(v);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flat_picture_stays_flat() {
        let src = vec![90u8; 40 * 30 * 3];
        let out = resize(&src, 40, 30, 3, 7, 5);
        assert_eq!(out.len(), 7 * 5 * 3);
        assert!(out.iter().all(|&v| v == 90));
    }

    #[test]
    fn halving_averages_neighbors() {
        // Columns 0, 100, 0, 100: halving gives the middle of each pair's spread.
        let src: Vec<u8> = (0..4).map(|x| if x % 2 == 0 { 0 } else { 100 }).collect();
        let out = resize(&src, 4, 1, 1, 2, 1);
        assert!(out.iter().all(|&v| (40..=60).contains(&v)), "{out:?}");
    }

    #[test]
    fn crops_by_fractions() {
        let rgb = Rgb {
            width: 10,
            height: 10,
            data: (0..300).map(|i| u8::try_from(i / 3).unwrap_or(0)).collect(),
        };
        let c = crop(&rgb, [0.5, 0.5, 1.0, 1.0]);
        assert_eq!((c.width, c.height), (5, 5));
        assert_eq!(c.data.first().copied(), Some(55));
    }
}
