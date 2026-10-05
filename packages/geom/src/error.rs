// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the crate error type

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{what}: {why}")]
    Invalid { what: &'static str, why: String },
    #[error("mesh {name}: {why}")]
    Mesh { name: String, why: String },
    #[error("{op}: {why}")]
    Geometry { op: &'static str, why: String },
    #[error("request: {0}")]
    Json(String),
    #[error("unknown operation \"{0}\"")]
    UnknownOp(String),
}

impl Error {
    pub fn invalid_arg(why: impl Into<String>) -> Self {
        Self::Invalid {
            what: "argument",
            why: why.into(),
        }
    }

    pub(crate) fn invalid(what: &'static str, why: impl Into<String>) -> Self {
        Self::Invalid {
            what,
            why: why.into(),
        }
    }

    pub(crate) fn geometry(op: &'static str, why: impl Into<String>) -> Self {
        Self::Geometry { op, why: why.into() }
    }

    pub(crate) fn mesh(name: impl Into<String>, why: impl Into<String>) -> Self {
        Self::Mesh {
            name: name.into(),
            why: why.into(),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
