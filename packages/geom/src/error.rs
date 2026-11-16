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
    /// A body too detailed to send back as text.
    #[error("{0}")]
    TooDetailed(TooDetailed),
}

/// A body too detailed to send back as text: `size` of `measure`, past its `limit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooDetailed {
    pub size: u64,
    pub limit: u64,
    pub measure: Measure,
}

impl std::fmt::Display for TooDetailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "brep: the body is too detailed to save as text ({} {}, limit {})",
            grouped(self.size),
            self.measure.words(),
            grouped(self.limit)
        )
    }
}

/// What a body sent back as text is counted by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Measure {
    Edges,
    ControlPoints,
}

impl Measure {
    /// its name in a reply
    #[must_use]
    pub fn key(self) -> &'static str {
        match self {
            Self::Edges => "edges",
            Self::ControlPoints => "controlPoints",
        }
    }

    /// its name in a sentence
    #[must_use]
    pub fn words(self) -> &'static str {
        match self {
            Self::Edges => "edges",
            Self::ControlPoints => "control points",
        }
    }
}

/// a count with its thousands set apart, as 3,412
fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_too_detailed_says_what_it_counted() {
        let e = |size, limit, measure| Error::TooDetailed(TooDetailed { size, limit, measure }).to_string();
        assert_eq!(
            e(3412, 3300, Measure::Edges),
            "brep: the body is too detailed to save as text (3,412 edges, limit 3,300)"
        );
        assert_eq!(
            e(183_005, 178_000, Measure::ControlPoints),
            "brep: the body is too detailed to save as text (183,005 control points, limit 178,000)"
        );
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000_000), "1,000,000");
    }
}
