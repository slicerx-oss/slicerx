// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! what takes the place of `kernel.rs` in a build without the kernel: the same names, and no way to make a solid
//!
//! A [`Solid`] has no values here, so everything that would read one can never run; the makers say why.
#![allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "the signatures of kernel.rs, where a solid is more than nothing"
)]

use crate::error::{Error, Result};
use crate::stitch::{Boundary, Path, Sheet};
use crate::values::{Params, Polygons, Shape, Vec3};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Solid {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct FaceRef<'s> {
    solid: &'s Solid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct EdgeRef<'s> {
    solid: &'s Solid,
}

pub(crate) fn cuboid(_corner: Vec3, _size: Vec3) -> Result<Solid> {
    Err(Error::NoKernel)
}

pub(crate) fn cylinder(_base: Vec3, _radius: f64, _height: f64) -> Result<Solid> {
    Err(Error::NoKernel)
}

pub(crate) fn cone(_base: Vec3, _base_radius: f64, _top_radius: f64, _height: f64) -> Result<Solid> {
    Err(Error::NoKernel)
}

pub(crate) fn sphere(_center: Vec3, _radius: f64) -> Result<Solid> {
    Err(Error::NoKernel)
}

pub(crate) fn skin_curves(_rails: &[Path], _at: &[(i32, f64)]) -> Result<Vec<Boundary>> {
    Err(Error::NoKernel)
}

pub(crate) fn stitched(_sheets: &[Sheet]) -> Result<(Solid, Vec<usize>, f64)> {
    Err(Error::NoKernel)
}

impl Solid {
    pub(crate) fn is_manifold(&self) -> Result<bool> {
        match *self {}
    }

    pub(crate) fn volume(&self, _accuracy: f64) -> Result<f64> {
        match *self {}
    }

    pub(crate) fn bounds(&self) -> Result<(Vec3, Vec3)> {
        match *self {}
    }

    pub(crate) fn faces(&self) -> Result<Vec<FaceRef<'_>>> {
        match *self {}
    }

    pub(crate) fn edges(&self) -> Result<Vec<EdgeRef<'_>>> {
        match *self {}
    }

    pub(crate) fn tessellate(&self, _params: Params) -> Result<Polygons> {
        match *self {}
    }

    pub(crate) fn text(&self) -> Result<String> {
        match *self {}
    }

    pub(crate) fn keys(&self) -> Result<Vec<u64>> {
        match *self {}
    }

    pub(crate) fn set_keys(&mut self, _keys: &[u64]) -> Result<()> {
        match *self {}
    }

    pub(crate) fn lend(&self) -> Result<i64> {
        match *self {}
    }
}

pub(crate) fn take_back(_number: i64) {}

pub(crate) fn take_over(_number: i64) -> Option<Solid> {
    None
}

impl FaceRef<'_> {
    pub(crate) fn flat_within(&self, _mm: f64) -> bool {
        match *self.solid {}
    }

    pub(crate) fn shape(&self) -> Shape {
        match *self.solid {}
    }
}

impl<'s> EdgeRef<'s> {
    pub(crate) fn faces(&self) -> Vec<FaceRef<'s>> {
        match *self.solid {}
    }

    pub(crate) fn curve_type(&self) -> i64 {
        match *self.solid {}
    }

    pub(crate) fn is_tangent(self) -> bool {
        match *self.solid {}
    }

    pub(crate) fn is_manifold(self) -> bool {
        match *self.solid {}
    }

    pub(crate) fn is_closed(self) -> bool {
        match *self.solid {}
    }

    pub(crate) fn distance_to(&self, _point: Vec3) -> Result<f64> {
        match *self.solid {}
    }

    pub(crate) fn ends(&self) -> Option<(Vec3, Vec3)> {
        match *self.solid {}
    }
}
