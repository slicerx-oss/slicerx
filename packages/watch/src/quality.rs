// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Frames not worth scoring: the light is off, the camera is blinded, or the picture is blurred
//! (the door is opening, the bed is moving fast). They are skipped and counted, never scored.

/// What a frame is good for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    /// Worth scoring.
    Usable,
    /// Mean brightness below [`DARK`].
    TooDark,
    /// Mean brightness above [`BRIGHT`].
    TooBright,
    /// Too little edge detail ([`BLUR`]).
    Blurred,
}

/// Mean luma (0 to 255) below which a frame is too dark: a chamber with its light off.
pub const DARK: f64 = 28.0;
/// Mean luma above which a frame is too bright: the camera looks into a lamp or the sun.
pub const BRIGHT: f64 = 235.0;
/// Variance of the Laplacian below which a frame is blurred. Measured on a 4-pixel grid, so it
/// does not depend much on resolution.
pub const BLUR: f64 = 8.0;

/// Judges a grayscale frame of `width` by `height`.
pub fn assess(gray: &[u8], width: u32, height: u32) -> Quality {
    let (cols, rows) = (width as usize, height as usize);
    if gray.len() < cols * rows || cols < 12 || rows < 12 {
        return Quality::Blurred;
    }
    let mean = gray.iter().map(|&g| f64::from(g)).sum::<f64>()
        / f64::from(u32::try_from(gray.len()).unwrap_or(u32::MAX));
    if mean < DARK {
        return Quality::TooDark;
    }
    if mean > BRIGHT {
        return Quality::TooBright;
    }
    let at = |x: usize, y: usize| f64::from(gray.get(y * cols + x).copied().unwrap_or_default());
    let step = 4;
    let (mut sum, mut sum_sq, mut count) = (0.0, 0.0, 0.0);
    let mut y = step;
    while y + step < rows {
        let mut x = step;
        while x + step < cols {
            let lap = at(x - step, y) + at(x + step, y) + at(x, y - step) + at(x, y + step) - 4.0 * at(x, y);
            sum += lap;
            sum_sq += lap * lap;
            count += 1.0;
            x += step;
        }
        y += step;
    }
    let variance = if count > 0.0 {
        sum_sq / count - (sum / count).powi(2)
    } else {
        0.0
    };
    if variance < BLUR {
        Quality::Blurred
    } else {
        Quality::Usable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker(level_a: u8, level_b: u8) -> Vec<u8> {
        (0..64 * 64)
            .map(|i| {
                if ((i % 64) / 8 + (i / 64) / 8) % 2 == 0 {
                    level_a
                } else {
                    level_b
                }
            })
            .collect()
    }

    #[test]
    fn sorts_frames() {
        assert_eq!(assess(&checker(60, 200), 64, 64), Quality::Usable);
        assert_eq!(assess(&checker(5, 20), 64, 64), Quality::TooDark);
        assert_eq!(assess(&checker(240, 250), 64, 64), Quality::TooBright);
        assert_eq!(assess(&vec![128; 64 * 64], 64, 64), Quality::Blurred);
    }
}
