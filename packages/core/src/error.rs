// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use std::ops::Range;

/// The one error type of `sx-core`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("mesh {name}: {reason}")]
    Mesh { name: String, reason: String },
    #[error("config key {key}: {reason}")]
    Config { key: &'static str, reason: String },
    #[error("the plate has no printable geometry")]
    EmptyPlate,
    #[error("layer range {start}..{end} is outside 0..{count}", start = range.start, end = range.end)]
    LayerRange { range: Range<u32>, count: u32 },
    #[error("{0} is not available in this build")]
    Unsupported(&'static str),
    #[error("blocked by the safety preflight: {0}")]
    Blocked(String),
    /// A by-object plate the toolhead, gantry or tool changer would run into (the command line's refusal of a slice
    /// with collisions; the engine itself reports them).
    #[error("printing by object is not safe: {0}")]
    Clearance(String),
    #[error("slicing was canceled")]
    Cancelled,
    #[error("writing G-code: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub(crate) fn mesh(name: &str, reason: impl Into<String>) -> Self {
        Self::Mesh {
            name: name.to_owned(),
            reason: reason.into(),
        }
    }
}
