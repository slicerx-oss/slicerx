// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The frame-change signal: how much of the bed area changed since the last scored frame, 10 s
//! earlier. On its own it means little (the toolhead moves between frames), so the policy
//! compares it with the same print's first frames and uses it only to strengthen what the model
//! sees: spaghetti grows and spreads, which a normal print's moving toolhead does not.
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "pixel counts and sizes are far below 2^52, and every float is clamped to the target range before it is cast"
)]
use crate::decode::Rgb;
use crate::mask::Mask;
use crate::resize::{crop, resize};

/// Thumbnail size the comparison runs at. Small, so noise and camera compression average out.
pub const THUMB_W: usize = 64;
/// Thumbnail height.
pub const THUMB_H: usize = 48;

/// Size of the plate check's thumbnail: about 1 mm per pixel on a 256 mm plate, so a speck a
/// few millimeters across still covers several pixels.
pub const PLATE_W: usize = 256;
/// Plate thumbnail height.
pub const PLATE_H: usize = 192;

/// A pixel counts as changed when it differs by more than this (0 to 255) once the overall
/// brightness is taken out. Camera noise and compression stay well under it after the
/// downscale averages them.
const PIXEL_CHANGE: f64 = 28.0;

/// A grayscale thumbnail of the mask's box, with which of its pixels lie inside the mask.
#[derive(Debug, Clone, PartialEq)]
pub struct Thumb {
    gray: Vec<u8>,
    inside: Vec<bool>,
    w: usize,
    h: usize,
    /// The mask's box in the frame, which the thumbnail covers.
    bbox: [f64; 4],
}

/// A patch that differs between two thumbnails.
#[derive(Debug, Clone, PartialEq)]
pub struct Spot {
    /// Left, top, right, bottom in frame coordinates from 0 to 1.
    pub bbox: [f64; 4],
    /// Changed pixels in the patch.
    pub pixels: usize,
    /// The patch's share of the bed area, 0 to 1.
    pub share: f64,
}

impl Thumb {
    /// The thumbnail of a frame's bed area.
    pub fn of(rgb: &Rgb, mask: &Mask) -> Self {
        Self::sized(rgb, mask, THUMB_W, THUMB_H)
    }

    /// The thumbnail of a frame's bed area at `w` by `h`.
    pub fn sized(rgb: &Rgb, mask: &Mask, w: usize, h: usize) -> Self {
        let bbox = mask.bounds();
        let area = crop(rgb, bbox);
        let gray = resize(&area.gray(), area.width as usize, area.height as usize, 1, w, h);
        let [left, top, right, bottom] = bbox;
        let inside = (0..w * h)
            .map(|i| {
                let col = (i % w) as f64 + 0.5;
                let row = (i / w) as f64 + 0.5;
                mask.contains(
                    left + (right - left) * col / w as f64,
                    top + (bottom - top) * row / h as f64,
                )
            })
            .collect();
        Self {
            gray,
            inside,
            w,
            h,
            bbox,
        }
    }

    /// The largest patch that differs from `earlier`, leaving out pixels whose center falls in
    /// one of the `ignore` boxes (frame coordinates). Patches under `min_pixels` are noise.
    pub fn spot(&self, earlier: &Thumb, ignore: &[[f64; 4]], min_pixels: usize) -> Option<Spot> {
        if (self.w, self.h) != (earlier.w, earlier.h) {
            return None;
        }
        let [left, top, right, bottom] = self.bbox;
        let at = |i: usize| {
            (
                left + (right - left) * ((i % self.w) as f64 + 0.5) / self.w as f64,
                top + (bottom - top) * ((i / self.w) as f64 + 0.5) / self.h as f64,
            )
        };
        let both: Vec<usize> = (0..self.w * self.h)
            .filter(|&i| self.inside.get(i) == Some(&true) && earlier.inside.get(i) == Some(&true))
            .collect();
        if both.is_empty() {
            return None;
        }
        let count = both.len() as f64;
        let mean = |g: &[u8]| {
            both.iter()
                .map(|&i| f64::from(g.get(i).copied().unwrap_or(0)))
                .sum::<f64>()
                / count
        };
        let (ma, mb) = (mean(&self.gray), mean(&earlier.gray));
        let mut changed = vec![false; self.w * self.h];
        for &i in &both {
            let (px, py) = at(i);
            if ignore
                .iter()
                .any(|&[il, it, ir, ib]| px >= il && px <= ir && py >= it && py <= ib)
            {
                continue;
            }
            let a = f64::from(self.gray.get(i).copied().unwrap_or(0)) - ma;
            let e = f64::from(earlier.gray.get(i).copied().unwrap_or(0)) - mb;
            if let Some(c) = changed.get_mut(i) {
                *c = (a - e).abs() > PIXEL_CHANGE;
            }
        }
        // The largest 8-connected patch of changed pixels.
        let mut seen = vec![false; changed.len()];
        let mut best: Option<(usize, [usize; 4])> = None;
        for start in 0..changed.len() {
            if !changed.get(start).copied().unwrap_or(false) || seen.get(start).copied().unwrap_or(true) {
                continue;
            }
            let mut stack = vec![start];
            let (mut size, mut bounds) = (0, [self.w, self.h, 0, 0]);
            if let Some(s) = seen.get_mut(start) {
                *s = true;
            }
            while let Some(i) = stack.pop() {
                size += 1;
                let (col, row) = (i % self.w, i / self.w);
                bounds = [
                    bounds[0].min(col),
                    bounds[1].min(row),
                    bounds[2].max(col),
                    bounds[3].max(row),
                ];
                for (dx, dy) in [
                    (-1, -1),
                    (0, -1),
                    (1, -1),
                    (-1, 0),
                    (1, 0),
                    (-1, 1),
                    (0, 1),
                    (1, 1),
                ] {
                    let (Some(nx), Some(ny)) = (col.checked_add_signed(dx), row.checked_add_signed(dy))
                    else {
                        continue;
                    };
                    if nx >= self.w || ny >= self.h {
                        continue;
                    }
                    let j = ny * self.w + nx;
                    if changed.get(j).copied().unwrap_or(false) && !seen.get(j).copied().unwrap_or(true) {
                        if let Some(s) = seen.get_mut(j) {
                            *s = true;
                        }
                        stack.push(j);
                    }
                }
            }
            if best.is_none_or(|(c, _)| size > c) {
                best = Some((size, bounds));
            }
        }
        let (pixels, [x0, y0, x1, y1]) = best.filter(|(c, _)| *c >= min_pixels)?;
        let fx = |x: usize| left + (right - left) * x as f64 / self.w as f64;
        let fy = |y: usize| top + (bottom - top) * y as f64 / self.h as f64;
        Some(Spot {
            bbox: [fx(x0), fy(y0), fx(x1 + 1), fy(y1 + 1)],
            pixels,
            share: pixels as f64 / count,
        })
    }

    /// Mean absolute difference inside the mask, 0 (same) to 1. The overall brightness of each
    /// thumbnail is taken out first, so a light flicker or auto exposure step is not a change.
    pub fn change(&self, earlier: &Thumb) -> f64 {
        let pairs: Vec<(f64, f64)> = self
            .gray
            .iter()
            .zip(&earlier.gray)
            .zip(self.inside.iter().zip(&earlier.inside))
            .filter(|(_, (a, b))| **a && **b)
            .map(|((&x, &y), _)| (f64::from(x), f64::from(y)))
            .collect();
        if pairs.is_empty() {
            return 0.0;
        }
        let n = pairs.len() as f64;
        let (ma, mb) = pairs
            .iter()
            .fold((0.0, 0.0), |(a, b), (x, y)| (a + x / n, b + y / n));
        pairs
            .iter()
            .map(|(x, y)| ((x - ma) - (y - mb)).abs())
            .sum::<f64>()
            / n
            / 255.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(f: impl Fn(u32, u32) -> u8) -> Rgb {
        let (width, height) = (128, 96);
        let data = (0..width * height)
            .flat_map(|i| {
                let v = f(i % width, i / width);
                [v, v, v]
            })
            .collect();
        Rgb { width, height, data }
    }

    #[test]
    fn brightness_alone_is_not_change() {
        let a = Thumb::of(&frame(|x, _| u8::try_from(x).unwrap_or(0)), &Mask::whole());
        let b = Thumb::of(&frame(|x, _| u8::try_from(x + 40).unwrap_or(0)), &Mask::whole());
        assert!(b.change(&a) < 0.01);
    }

    /// An empty plate: a smooth gradient with a little camera noise.
    fn plate(x: u32, y: u32) -> u8 {
        let noise = u8::try_from((x * 7 + y * 13) % 5).unwrap_or(0);
        u8::try_from(90 + x / 8 + y / 16).unwrap_or(200) + noise
    }

    fn big(f: impl Fn(u32, u32) -> u8) -> Rgb {
        let (width, height) = (640, 480);
        let data = (0..width * height)
            .flat_map(|i| {
                let v = f(i % width, i / width);
                [v, v, v]
            })
            .collect();
        Rgb { width, height, data }
    }

    #[test]
    fn a_speck_on_the_plate_is_found_where_it_is() {
        let mask = Mask::whole();
        let empty = Thumb::sized(&big(plate), &mask, PLATE_W, PLATE_H);
        // The same plate under a slightly brighter light: nothing.
        let lit = Thumb::sized(
            &big(|x, y| plate(x, y).saturating_add(25)),
            &mask,
            PLATE_W,
            PLATE_H,
        );
        assert_eq!(lit.spot(&empty, &[], 3), None);
        // A dark speck about 8 pixels across (a few millimeters on a real plate).
        let speck = |x: u32, y: u32| {
            if (400..408).contains(&x) && (300..308).contains(&y) {
                20
            } else {
                plate(x, y)
            }
        };
        let now = Thumb::sized(&big(speck), &mask, PLATE_W, PLATE_H);
        let spot = now.spot(&empty, &[], 3).expect("the speck is found");
        let [left, top, right, bottom] = spot.bbox;
        assert!(left <= 400.0 / 640.0 && right >= 408.0 / 640.0, "{spot:?}");
        assert!(top <= 300.0 / 480.0 && bottom >= 308.0 / 480.0, "{spot:?}");
        assert!(
            right - left < 0.03 && bottom - top < 0.04,
            "a tight box: {spot:?}"
        );
        // A plate mark the person said is fine is left out.
        assert_eq!(now.spot(&empty, &[[0.6, 0.6, 0.66, 0.66]], 3), None);
    }

    #[test]
    fn a_hand_is_one_big_patch() {
        let mask = Mask::whole();
        let before = Thumb::of(&big(plate), &mask);
        let hand = |x: u32, y: u32| {
            if (100..300).contains(&x) && (200..480).contains(&y) {
                200
            } else {
                plate(x, y)
            }
        };
        let s = Thumb::of(&big(hand), &mask)
            .spot(&before, &[], 4)
            .expect("the hand");
        assert!(s.share > 0.1, "{s:?}");
        assert!(s.bbox[0] < 0.17 && s.bbox[2] > 0.45, "{s:?}");
    }

    #[test]
    fn change_outside_the_mask_does_not_count() {
        let mask = Mask::new(vec![[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]]);
        let a = Thumb::of(&frame(|_, _| 100), &mask);
        // Something moves in the top half only (outside the plate).
        let b = Thumb::of(&frame(|x, y| if y < 40 && x < 64 { 250 } else { 100 }), &mask);
        assert!(b.change(&a) < 0.01);
        let c = Thumb::of(&frame(|x, y| if y > 60 && x < 64 { 250 } else { 100 }), &mask);
        assert!(c.change(&a) > 0.1);
    }
}
