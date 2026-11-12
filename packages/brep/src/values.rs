// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the plain values that cross the bridge: what `kernel.rs` hands the rest of the crate, with no pointers in them
// a build without the kernel never makes most of these
#![cfg_attr(not(sx_brep_kernel), allow(dead_code))]

/// A point or a direction, laid out as the kernel's `SmVector3d` (`kernel.rs` checks the layout).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl From<[f64; 3]> for Vec3 {
    fn from([x, y, z]: [f64; 3]) -> Self {
        Self { x, y, z }
    }
}

impl From<Vec3> for [f64; 3] {
    fn from(v: Vec3) -> Self {
        [v.x, v.y, v.z]
    }
}

/// Tessellation limits, laid out as the kernel's `SmTessellationParams`. Zero switches a limit off.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Params {
    pub chord: f64,
    pub curve_angle_deg: f64,
    pub surface_angle_deg: f64,
    pub max_edge: f64,
    pub max_aspect: f64,
}

/// A kernel placement: an origin and three unit axes, z being x cross y.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Placement {
    pub origin: Vec3,
    pub x: Vec3,
    pub y: Vec3,
    pub z: Vec3,
}

/// A face's surface as the kernel holds it: its own type, and for the five analytic ones its own parameters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Shape {
    Plane(Placement),
    Cylinder {
        at: Placement,
        radius: f64,
    },
    /// `radius` is at the placement's origin; the half angle is positive where the cone widens along z. The apex
    /// is none when the kernel says there is none (a half angle of 0).
    Cone {
        at: Placement,
        radius: f64,
        half_angle_deg: f64,
        apex: Option<Vec3>,
    },
    Sphere {
        at: Placement,
        radius: f64,
    },
    Torus {
        at: Placement,
        major: f64,
        minor: f64,
    },
    /// Any other surface, or one of the five whose parameters the kernel would not give, by its type code.
    Other(i64),
}

/// The kernel's tessellation of a solid, copied out as it stands: nothing welded, dropped or judged.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Polygons {
    /// One per vertex of the kernel's mesh, in the order the triangles first use them. Triangles that share a
    /// kernel vertex share the index.
    pub positions: Vec<Vec3>,
    pub triangles: Vec<[u32; 3]>,
    /// For each triangle, its face's place in the solid's face list.
    pub faces: Vec<u32>,
    /// For each triangle corner, the surface normal the kernel stored there, or none when it stored nothing.
    pub normals: Vec<[Option<Vec3>; 3]>,
    /// For each triangle corner, which of the kernel's records its normal comes from, or none. The kernel keeps one
    /// record for a vertex on a face, and two where the face meets itself along a seam.
    pub records: Vec<[Option<u32>; 3]>,
}
