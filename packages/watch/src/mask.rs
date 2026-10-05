// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The bed mask: the part of the frame where findings count, drawn once per camera by the
//! person (hub setting `watchMask`). Outside it are the purge chute, the toolhead's parking
//! spot and anything off the plate.
use serde::Deserialize;

/// A polygon in frame coordinates from 0 to 1, x to the right and y down.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(transparent)]
pub struct Mask(Vec<[f64; 2]>);

impl Mask {
    /// A mask from its corners. Fewer than three corners covers the whole frame.
    pub fn new(points: Vec<[f64; 2]>) -> Self {
        Self(points)
    }

    /// The whole frame, used until the person draws a mask.
    pub fn whole() -> Self {
        Self(Vec::new())
    }

    /// The smallest box around the mask (left, top, right, bottom), the whole frame until drawn.
    pub fn bounds(&self) -> [f64; 4] {
        if self.0.len() < 3 {
            return [0.0, 0.0, 1.0, 1.0];
        }
        self.0.iter().fold([1.0, 1.0, 0.0, 0.0], |[l, t, r, b], &[x, y]| {
            let (x, y) = (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0));
            [l.min(x), t.min(y), r.max(x), b.max(y)]
        })
    }

    /// True when the point is inside (even-odd rule). The whole-frame mask contains everything.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        if self.0.len() < 3 {
            return true;
        }
        let mut inside = false;
        let n = self.0.len();
        for i in 0..n {
            let ([xi, yi], [xj, yj]) = (
                self.0.get(i).copied().unwrap_or_default(),
                self.0.get((i + n - 1) % n).copied().unwrap_or_default(),
            );
            if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
                inside = !inside;
            }
        }
        inside
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_frame_until_drawn() {
        assert!(Mask::whole().contains(0.99, 0.01));
    }

    #[test]
    fn a_drawn_plate_keeps_the_chute_out() {
        // A trapezoid plate in the lower part of the frame.
        let m = Mask::new(vec![[0.1, 0.5], [0.9, 0.5], [1.0, 0.95], [0.0, 0.95]]);
        assert!(m.contains(0.5, 0.7));
        assert!(!m.contains(0.5, 0.3));
        assert!(!m.contains(0.02, 0.55));
        let near = |a: [f64; 4], b: [f64; 4]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-12);
        assert!(near(m.bounds(), [0.0, 0.5, 1.0, 0.95]));
        assert!(near(Mask::whole().bounds(), [0.0, 0.0, 1.0, 1.0]));
    }
}
