// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx-geom`: mesh operations for `SlicerX`.
//!
//! units are millimeters in `f64`, Z up, bed at Z = 0. triangles are counterclockwise
//! seen from outside; 2D outer rings are counterclockwise, holes clockwise.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]
// geometry code names points and coordinates a, b, c, p, q, u, v by convention
#![allow(clippy::many_single_char_names, clippy::similar_names)]
// counts and indices converted to f64 stay far below 2^52
#![allow(clippy::cast_precision_loss)]

pub mod array;
pub mod boolean;
pub mod build;
#[cfg(feature = "calib")]
pub mod calib;
pub mod convex;
pub mod cut;
#[cfg(feature = "cad")]
pub mod dimension;
#[cfg(feature = "cad")]
pub mod edge;
pub mod emboss;
mod error;
#[cfg(feature = "cad")]
pub mod face;
pub mod faces;
pub mod fit;
pub mod fm;
pub mod font;
#[cfg(feature = "holes")]
pub mod hole;
#[cfg(feature = "hollow")]
pub mod hollow;
pub mod import;
pub mod json;
mod json_cad;
pub mod layers;
pub mod measure;
pub mod mesh;
#[cfg(feature = "nest")]
pub mod nest;
pub mod orient;
#[cfg(feature = "text")]
pub mod outline;
#[cfg(feature = "calib")]
pub mod pa;
pub mod poly2d;
#[cfg(feature = "cad")]
pub mod push;
pub mod repair;
pub mod resume;
#[cfg(feature = "shell")]
pub mod shell;
pub mod simplify;
#[cfg(feature = "cad")]
pub mod sketch;
#[cfg(feature = "cad")]
pub mod sketch_corner;
pub mod solids;
pub mod split;
#[cfg(feature = "svg")]
pub mod svg;
#[cfg(feature = "threads")]
pub mod thread;
pub mod vec3;
pub mod xform;

pub use error::{Error, Result};
pub use mesh::{Aabb, TriMesh};
pub use poly2d::Polygon;
pub use vec3::{Plane, V2, V3};
