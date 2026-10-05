// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The detector: one frame in, scored boxes out. It keeps no state; agreement over frames, the
//! bed mask and thresholds live in [`crate::policy`].
use crate::decode::Rgb;
use crate::protocol::Kind;

/// One thing the detector saw.
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    /// What it is.
    pub kind: Kind,
    /// 0 to 1.
    pub score: f64,
    /// Box in frame coordinates from 0 to 1: left, top, right, bottom.
    pub bbox: [f64; 4],
}

impl Detection {
    /// The box center, used against the bed mask.
    pub fn center(&self) -> (f64, f64) {
        let [l, t, r, b] = self.bbox;
        (f64::midpoint(l, r), f64::midpoint(t, b))
    }
}

/// A failure detector model.
pub trait Detector: Send + Sync {
    /// Name and version, written into each report's note.
    fn name(&self) -> &str;
    /// Everything it sees in the frame, unfiltered.
    fn detect(&self, frame: &Rgb) -> Vec<Detection>;
    /// True for a model that scores a whole picture rather than boxing things in it. The
    /// session then gives it only the bed mask's box, takes its scores without a position
    /// check, and scores them against the print's own start ([`crate::policy::Relative`]).
    fn whole_image(&self) -> bool {
        false
    }
}

/// Finds nothing. Used when the model file is missing, so the frame loop, masks and reports
/// still run end to end.
#[derive(Debug, Default, Clone, Copy)]
pub struct Stub;

impl Detector for Stub {
    fn name(&self) -> &'static str {
        "stub"
    }

    fn detect(&self, _frame: &Rgb) -> Vec<Detection> {
        Vec::new()
    }
}

impl<T: Detector + ?Sized> Detector for Box<T> {
    fn name(&self) -> &str {
        (**self).name()
    }

    fn detect(&self, frame: &Rgb) -> Vec<Detection> {
        (**self).detect(frame)
    }

    fn whole_image(&self) -> bool {
        (**self).whole_image()
    }
}
