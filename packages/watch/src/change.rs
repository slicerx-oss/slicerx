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

/// A grayscale thumbnail of the mask's box, with which of its pixels lie inside the mask.
#[derive(Debug, Clone, PartialEq)]
pub struct Thumb {
    gray: Vec<u8>,
    inside: Vec<bool>,
}

impl Thumb {
    /// The thumbnail of a frame's bed area.
    pub fn of(rgb: &Rgb, mask: &Mask) -> Self {
        let bbox = mask.bounds();
        let area = crop(rgb, bbox);
        let gray = resize(
            &area.gray(),
            area.width as usize,
            area.height as usize,
            1,
            THUMB_W,
            THUMB_H,
        );
        let [left, top, right, bottom] = bbox;
        let inside = (0..THUMB_W * THUMB_H)
            .map(|i| {
                let col = (i % THUMB_W) as f64 + 0.5;
                let row = (i / THUMB_W) as f64 + 0.5;
                mask.contains(
                    left + (right - left) * col / THUMB_W as f64,
                    top + (bottom - top) * row / THUMB_H as f64,
                )
            })
            .collect();
        Self { gray, inside }
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
