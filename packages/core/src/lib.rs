// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx-core`: the `SlicerX` slicing engine.
//!
//! Takes bytes and returns bytes. No filesystem, networking, async runtime or
//! Tauri; clocks go through [`platform::Clock`]. Per-layer parallelism uses rayon
//! behind the default `parallel` feature, which the WASM build turns off.
//!
//! # Units
//!
//! Every public API takes millimeters (`f32` for mesh and preview data, `f64`
//! for settings). Inside the crate, 2D geometry uses `i32` coordinates where one
//! unit is 0.1 micrometer ([`geom::SCALE`] units per millimeter), so a 256 mm
//! bed spans 2,560,000 units and every cross product fits in `i64`.
//!
//! # Pipeline
//!
//! 1 layer plan, 2 contours, 3 perimeters, 4 surfaces, 5 infill, 6 path plan,
//! 7 G-code, 8 preview. Stages 1 to
//! 6 run in [`slice`] and [`slice_range`]; 7 and 8 run in [`emit_gcode`] and
//! [`preview_buffers`] over the resulting [`SliceOutput`].
//!
//! # Public API
//!
//! Embedders use [`api`], the only module covered by semver. The items at the
//! crate root re-export the same types for the workspace's own crates.
//!
//! # Sharding
//!
//! [`slice_range`] slices a range of layers and reads a halo of neighbor
//! layers so top and bottom detection matches a full run. Every layer's output
//! depends only on its own geometry and its neighbors inside the halo, so
//! concatenating the G-code of shards gives the same bytes as one full run, and
//! [`preview::stitch`] does the same for SXPV.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]
// Geometry code names points and coordinates a, b, c, x, y, s, t by convention.
#![allow(clippy::many_single_char_names, clippy::similar_names)]
// Per-layer stage functions read top to bottom as the pipeline; splitting them
// would scatter the stage order.
#![allow(clippy::too_many_lines)]

mod adaptive;
mod anchor;
mod chain;
mod cooling;
mod copies;
mod counterbore;
mod equalizer;
mod fm;
mod owners;
mod smallflow;
mod zoneroute;
// The wall generator works on a graph of vector indices and on lengths in nanometers held in `i64`,
// converted to and from `f64` and the crate's `i32` grid at the edges.
pub mod api;
#[allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    reason = "graph indices and nanometer lengths, see the module docs"
)]
mod arachne;
#[doc(hidden)]
pub mod arcfit;
#[doc(hidden)]
pub mod bgcode;
mod brick;
#[allow(
    clippy::indexing_slicing,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "rotated frame arithmetic on plate coordinates"
)]
mod bridging;
mod brim;
mod classify;
#[doc(hidden)]
pub mod collide;
mod compensate;
#[doc(hidden)]
pub mod config;
// The chain joining walks its own index lists, as Orca's does.
#[allow(clippy::indexing_slicing)]
mod contours;
mod customgcode;
mod edge;
mod error;
#[doc(hidden)]
pub mod extras;
mod fillgap;
#[doc(hidden)]
pub mod firmware;
mod floating;
mod fuzzy;
mod gapfill;
#[doc(hidden)]
pub mod gcode;
#[doc(hidden)]
pub mod gcode_lint;
#[doc(hidden)]
pub mod geom;
mod griffin;
mod infill;
#[doc(hidden)]
pub mod inner_offset;
#[allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    reason = "voxel grid arithmetic on small fixed-size vectors and cell coordinates"
)]
mod interlock;
#[doc(hidden)]
pub mod ironing;
#[doc(hidden)]
pub mod jpeg;
mod layers;
mod lightning;
#[doc(hidden)]
pub mod mesh;
mod monotonic;
#[doc(hidden)]
pub mod motion;
mod narrow;
mod noise;
pub mod nozzles;
mod organic;
pub mod outname;
mod output;
mod overhang;
#[doc(hidden)]
pub mod paint;
mod par;
mod paths;
mod patterns;
mod perimeters;
#[doc(hidden)]
pub mod plate;
#[doc(hidden)]
pub mod platform;
#[doc(hidden)]
pub mod preflight;
mod preheat;
#[doc(hidden)]
pub mod preview;
pub mod printtime;
#[cfg(feature = "sleipnir")]
mod sleipnir;
// Indices walk the point lists they index, as Orca's loops do.
#[allow(clippy::indexing_slicing)]
mod extraperim;
// Indices walk the point lists they index, as Orca's loops do.
#[allow(clippy::indexing_slicing)]
mod quality;
mod raft;
#[allow(
    clippy::indexing_slicing,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    reason = "mesh and ray arithmetic over fixed-size vectors and loops bounded by the mesh"
)]
mod raycast;
mod rotation;
#[allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "polyline arithmetic over points of the ring being cut, indices bounded by its length"
)]
mod scarf;
mod seam;
#[allow(
    clippy::indexing_slicing,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    reason = "candidate points and spline rows indexed inside loops bounded by their own lengths"
)]
mod seamplan;
mod sequence;
mod session;
mod sha256;
mod shells;
mod smooth;
mod sorting;
mod spiral;
#[doc(hidden)]
pub mod subst;
mod support;
mod supportfill;
mod supportgrid;
#[doc(hidden)]
pub mod surface;
mod tall;
#[doc(hidden)]
pub mod template;
#[doc(hidden)]
pub mod threemf;
#[doc(hidden)]
pub mod thumbnail;
mod timelapse;
mod toolorder;
mod tower;
mod tpms;
#[doc(hidden)]
pub mod travel;
mod treeclassic;
mod treepaths;
#[doc(hidden)]
pub mod validate;
mod wave;
mod weight;

use std::ops::Range;

pub use config::{GcodeFlavor, InfillPattern, PrintConfig};
pub use error::{Error, Result};
pub use gcode::{EmitOptions, GcodeStats, emit_gcode, emit_gcode_with};
pub use mesh::{Mesh, MeshPart};
pub use output::{Feature, LayerPaths, PathInfo, SliceOutput, SliceWarning, Stage, StageMicros, WarningCode};
pub use plate::{Bed, Plate, PlateObject};
pub use preview::preview_buffers;
pub use session::{HeightRange, SliceSession};

/// Options for one slice run that are not print settings.
#[derive(Debug, Clone, Default)]
pub struct SliceOptions {
    /// G-code dialect for [`emit_gcode`]. `None` uses the config's `gcode_flavor`.
    pub flavor: Option<GcodeFlavor>,
}

/// Receives progress while a slice runs. Implementations must be cheap; the
/// core calls this from worker threads.
pub trait Progress: Sync {
    /// `fraction` is 0 to 1 within `stage`.
    fn report(&self, stage: Stage, fraction: f32);

    /// True once the caller wants the run to stop. The core checks it per
    /// layer and between stages and then returns [`Error::Cancelled`]. Must
    /// be cheap (an atomic load).
    fn cancelled(&self) -> bool {
        false
    }
}

/// A [`Progress`] that forwards reports to `progress` and reads a cancel
/// flag: set the flag from any thread and the run stops with
/// [`Error::Cancelled`] at the next layer boundary.
#[derive(Clone, Copy)]
pub struct Cancellable<'a> {
    pub progress: &'a dyn Progress,
    pub flag: &'a std::sync::atomic::AtomicBool,
}

impl Progress for Cancellable<'_> {
    fn report(&self, stage: Stage, fraction: f32) {
        self.progress.report(stage, fraction);
    }

    fn cancelled(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::Relaxed) || self.progress.cancelled()
    }
}

/// A [`Progress`] that ignores every report.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoProgress;

impl Progress for NoProgress {
    fn report(&self, _stage: Stage, _fraction: f32) {}
}

/// A slicing engine. `sx-core` is the default; another engine can implement the same trait.
pub trait SliceEngine {
    fn slice(
        &self,
        plate: &Plate,
        config: &PrintConfig,
        opts: &SliceOptions,
        progress: &dyn Progress,
    ) -> Result<SliceOutput>;
}

/// The built-in engine.
#[derive(Debug, Clone, Copy, Default)]
pub struct SxEngine;

impl SliceEngine for SxEngine {
    fn slice(
        &self,
        plate: &Plate,
        config: &PrintConfig,
        _opts: &SliceOptions,
        progress: &dyn Progress,
    ) -> Result<SliceOutput> {
        let session = SliceSession::new(plate, config)?;
        session.slice_range_with(config, 0..session.layer_count(), progress)
    }
}

/// Slices every layer of the plate (stages 1 to 6).
///
/// ```no_run
/// # fn run(bytes: &[u8]) -> sx_core::Result<()> {
/// use sx_core::{Mesh, Plate, PrintConfig, SliceOptions};
/// let mesh = Mesh::load(bytes, "part.stl")?;
/// let plate = Plate::single(mesh);
/// let config = PrintConfig::default();
/// let out = sx_core::slice(&plate, &config, &SliceOptions::default())?;
/// let mut gcode = Vec::new();
/// sx_core::emit_gcode(&out, &config, config.gcode_flavor, &mut gcode)?;
/// # Ok(()) }
/// ```
pub fn slice(plate: &Plate, config: &PrintConfig, opts: &SliceOptions) -> Result<SliceOutput> {
    SxEngine.slice(plate, config, opts, &NoProgress)
}

/// Slices `layers` only, reading `halo` extra layers on each side for top and
/// bottom detection. `halo` below the largest shell count is raised to it, so
/// the output always matches the same layers of a full run.
pub fn slice_range(
    plate: &Plate,
    config: &PrintConfig,
    layers: Range<u32>,
    halo: u32,
) -> Result<SliceOutput> {
    let _ = halo;
    let session = SliceSession::new(plate, config)?;
    session.slice_range_with(config, layers, &NoProgress)
}
