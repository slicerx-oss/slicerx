// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! model files as plain data

pub(crate) mod json;
pub mod threemf;
mod xml;
mod zip;

pub use threemf::{Layout, Object, Paint, Part, PartKind, Plate, Project, read_3mf, read_entry};
