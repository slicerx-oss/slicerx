// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! why a typed kernel call failed, in words a person can act on

use std::fmt;

/// Where the kernel was when a face failed to tessellate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Sampling the face's edges.
    Boundary,
    /// Filling the face with triangles.
    Face,
    /// Writing the triangles out.
    Output,
    /// A stage this crate does not know, by the kernel's number.
    Other(i32),
}

/// One face the kernel could not tessellate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FailedFace {
    /// Its place in [`crate::Body::faces`].
    pub face: usize,
    pub stage: Stage,
    /// The kernel's status for it.
    pub status: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// This build has no kernel (`KERNEL` is false).
    NoKernel,
    /// An input was refused before the kernel saw it.
    Input { what: &'static str, why: String },
    /// The kernel refused, with its status (1000 is its success, so never that).
    Kernel { op: &'static str, status: i64 },
    /// C++ code under the call threw. Whatever the call was working on is leaked, never freed twice.
    Threw { op: &'static str, what: String },
    /// The kernel reported success, but what it made is not a solid.
    NotSolid { op: &'static str, why: &'static str },
    /// Faces given to be joined do not meet along a side they share. The kernel closed a gap this wide, in mm, to
    /// join them, so the solid it made is not the one asked for.
    Apart { gap_mm: f64 },
    /// The kernel joined faces along a side this far, in mm, from the curves they were given, so the solid it made
    /// is not the one asked for. The gap it reports does not show this.
    Moved { off_mm: f64 },
    /// The triangles made of a body stay this far from its surface, in mm, more than the chord asked for, and
    /// splitting them further did not bring them closer.
    Coarse { off_mm: f64, chord_mm: f64 },
    /// The kernel could not tessellate these faces. It made no mesh.
    Faces { status: i64, faces: Vec<FailedFace> },
    /// The kernel's tessellation is not something a mesh can hold.
    Mesh { why: String },
}

impl Error {
    pub(crate) fn input(what: &'static str, why: impl Into<String>) -> Self {
        Self::Input {
            what,
            why: why.into(),
        }
    }
}

/// A distance in mm as a person reads it: three figures that count, no exponent, no zeros after them.
fn plain(mm: f64) -> String {
    if !mm.is_finite() || mm == 0.0 {
        return format!("{mm}");
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a power of ten of a finite f64 is within 309 either way"
    )]
    let places = (2 - mm.abs().log10().floor() as i32).clamp(0, 17);
    let places = usize::try_from(places).unwrap_or(0);
    let text = format!("{mm:.places$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        text
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoKernel => f.write_str(
                "this build has no B-rep kernel (packages/brep/scripts/fetch-smlib.sh, then build again)",
            ),
            Self::Input { what, why } => write!(f, "{what}: {why}"),
            Self::Kernel { op, status } => write!(f, "{op}: the kernel refused (status {status})"),
            Self::Threw { op, what } => write!(f, "{op}: the kernel stopped with an error ({what})"),
            Self::NotSolid { op, why } => write!(f, "{op}: the result is not a solid: {why}"),
            Self::Apart { gap_mm } => write!(
                f,
                "stitch: the faces are {gap_mm:.3e} mm apart along a side they share; they must meet"
            ),
            Self::Moved { off_mm } => write!(
                f,
                "stitch: the faces were joined along a side {off_mm:.3e} mm off the curves they were given; they must meet on them"
            ),
            Self::Coarse { off_mm, chord_mm } => write!(
                f,
                "tessellate: the triangles stay {} mm from the surface, more than the {} mm asked for; ask for a larger chord",
                plain(*off_mm),
                plain(*chord_mm)
            ),
            Self::Faces { status, faces } => {
                write!(f, "tessellate: the kernel could not tessellate")?;
                if faces.is_empty() {
                    return write!(f, " the body (status {status})");
                }
                for (i, failed) in faces.iter().enumerate() {
                    let stage = match failed.stage {
                        Stage::Boundary => "while sampling its edges",
                        Stage::Face => "while filling it with triangles",
                        Stage::Output => "while writing its triangles",
                        Stage::Other(_) => "at a stage of its own",
                    };
                    let sep = if i == 0 { "" } else { "," };
                    write!(f, "{sep} face {} {stage} (status {})", failed.face, failed.status)?;
                }
                Ok(())
            }
            Self::Mesh { why } => write!(f, "tessellate: {why}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_read_as_plain_sentences() {
        assert_eq!(
            Error::input("radius", "must be more than 0 mm").to_string(),
            "radius: must be more than 0 mm"
        );
        assert_eq!(
            Error::Kernel {
                op: "sphere",
                status: 1007
            }
            .to_string(),
            "sphere: the kernel refused (status 1007)"
        );
        assert_eq!(
            Error::NotSolid {
                op: "sphere",
                why: "it encloses no volume"
            }
            .to_string(),
            "sphere: the result is not a solid: it encloses no volume"
        );
        let two = Error::Faces {
            status: 1001,
            faces: vec![
                FailedFace {
                    face: 0,
                    stage: Stage::Boundary,
                    status: 1001,
                },
                FailedFace {
                    face: 3,
                    stage: Stage::Face,
                    status: 1006,
                },
            ],
        };
        assert_eq!(
            two.to_string(),
            "tessellate: the kernel could not tessellate face 0 while sampling its edges (status 1001), face 3 \
             while filling it with triangles (status 1006)"
        );
        let none = Error::Faces {
            status: 1001,
            faces: Vec::new(),
        };
        assert_eq!(
            none.to_string(),
            "tessellate: the kernel could not tessellate the body (status 1001)"
        );
    }
}
