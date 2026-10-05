// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! JSON solids for the `build` and `subtract` operations
// fixed-size vectors and rings indexed modulo their length
#![allow(clippy::indexing_slicing)]

use crate::build;
use crate::convex::ConvexSolid;
use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d::{self, Polygon};
use crate::vec3::{self, Frame, Plane, V2, V3};
use serde::Deserialize;

const OVERSHOOT_MM: f64 = 0.01;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SolidSpec {
    Box {
        min: V3,
        max: V3,
    },
    Cylinder {
        origin: Option<V3>,
        axis: Option<V3>,
        diameter_mm: Option<f64>,
        radius_mm: Option<f64>,
        height_mm: f64,
        segments: Option<usize>,
    },
    #[serde(alias = "extrude")]
    Prism {
        origin: Option<V3>,
        axis: Option<V3>,
        points: Vec<V2>,
        #[serde(default)]
        holes: Vec<Vec<V2>>,
        height_mm: f64,
    },
    Countersink {
        origin: Option<V3>,
        axis: Option<V3>,
        shaft_diameter_mm: f64,
        head_diameter_mm: f64,
        angle_deg: Option<f64>,
        depth_mm: f64,
        segments: Option<usize>,
    },
}

fn frame(origin: Option<V3>, axis: Option<V3>) -> Result<Frame> {
    Frame::from_normal(origin.unwrap_or([0.0; 3]), axis.unwrap_or([0.0, 0.0, 1.0]), None)
        .ok_or_else(|| Error::invalid("axis", "must be a non-zero vector"))
}

fn positive(what: &'static str, v: f64) -> Result<f64> {
    if v.is_finite() && v > 0.0 {
        Ok(v)
    } else {
        Err(Error::invalid(what, "must be above 0"))
    }
}

fn radius(diameter: Option<f64>, radius: Option<f64>) -> Result<f64> {
    match (diameter, radius) {
        (Some(d), _) => positive("diameterMm", d).map(|d| d / 2.0),
        (None, Some(r)) => positive("radiusMm", r),
        _ => Err(Error::invalid("cylinder", "needs diameterMm or radiusMm")),
    }
}

fn segments(r: f64, given: Option<usize>) -> usize {
    given.map_or_else(
        // past about 64 sides the boolean caps grow quadratically; 48 keeps chord error near 0.05 mm at 10 mm radius
        || build::circle_segments(r, 0.02).min(48),
        |s| s.clamp(6, 128),
    )
}

fn is_convex(ring: &[V2]) -> bool {
    let n = ring.len();
    let sign = poly2d::signed_area(ring).signum();
    (0..n).all(|i| {
        let (a, b, c) = (ring[i % n], ring[(i + 1) % n], ring[(i + 2) % n]);
        poly2d::orient(a, b, c) * sign >= -1e-12
    })
}

fn frustum(f: &Frame, r0: f64, r1: f64, h0: f64, h1: f64, n: usize) -> Result<ConvexSolid> {
    let ring = |r: f64, h: f64, i: usize| {
        let t = std::f64::consts::TAU * i as f64 / n as f64;
        f.at([r * t.m_cos(), r * t.m_sin()], h)
    };
    let mut planes = Vec::with_capacity(n + 2);
    for i in 0..n {
        let (a0, b0, a1) = (ring(r0, h0, i), ring(r0, h0, i + 1), ring(r1, h1, i));
        let normal = vec3::cross(vec3::sub(b0, a0), vec3::sub(a1, a0));
        let normal = if vec3::dot(normal, vec3::sub(a0, f.at([0.0, 0.0], h0))) < 0.0 {
            vec3::scale(normal, -1.0)
        } else {
            normal
        };
        if let Some(p) = Plane::new(a0, normal) {
            planes.push(p);
        }
    }
    planes.push(Plane {
        normal: f.w,
        offset: vec3::dot(f.w, f.at([0.0, 0.0], h1)),
    });
    planes.push(Plane {
        normal: vec3::scale(f.w, -1.0),
        offset: -vec3::dot(f.w, f.at([0.0, 0.0], h0)),
    });
    if planes.len() < 5 {
        return Err(Error::invalid("solid", "degenerate cone"));
    }
    Ok(ConvexSolid { planes })
}

impl SolidSpec {
    pub fn to_mesh(&self) -> Result<TriMesh> {
        match self {
            Self::Box { min, max } => {
                if (0..3).any(|i| max[i] <= min[i]) {
                    return Err(Error::invalid("box", "max must be above min on every axis"));
                }
                Ok(build::box_mesh(*min, *max))
            }
            Self::Cylinder {
                origin,
                axis,
                diameter_mm,
                radius_mm,
                height_mm,
                segments: s,
            } => {
                let r = radius(*diameter_mm, *radius_mm)?;
                let h = positive("heightMm", *height_mm)?;
                Ok(build::cylinder(
                    &frame(*origin, *axis)?,
                    r,
                    0.0,
                    h,
                    segments(r, *s),
                ))
            }
            Self::Prism {
                origin,
                axis,
                points,
                holes,
                height_mm,
            } => {
                let h = positive("heightMm", *height_mm)?;
                if points.len() < 3 {
                    return Err(Error::invalid("points", "needs 3 or more points"));
                }
                let mut poly = Polygon::simple(points.clone());
                for hole in holes {
                    let mut ring = hole.clone();
                    if poly2d::signed_area(&ring) > 0.0 {
                        ring.reverse();
                    }
                    poly.holes.push(ring);
                }
                build::extrude(&[poly], &frame(*origin, *axis)?, 0.0, h)
            }
            Self::Countersink { .. } => Err(Error::invalid("solid", "a countersink is only for subtract")),
        }
    }

    pub fn to_convex(&self) -> Result<Vec<ConvexSolid>> {
        match self {
            Self::Box { min, max } => {
                if (0..3).any(|i| max[i] <= min[i]) {
                    return Err(Error::invalid("box", "max must be above min on every axis"));
                }
                let c = vec3::scale(vec3::add(*min, *max), 0.5);
                let half = vec3::scale(vec3::sub(*max, *min), 0.5);
                let ring = poly2d::rect([-half[0], -half[1]], [half[0], half[1]]);
                let f = Frame {
                    origin: [c[0], c[1], min[2]],
                    ..Frame::WORLD
                };
                Ok(vec![ConvexSolid::prism(&f, &ring, 0.0, max[2] - min[2])?])
            }
            Self::Cylinder {
                origin,
                axis,
                diameter_mm,
                radius_mm,
                height_mm,
                segments: s,
            } => {
                let r = radius(*diameter_mm, *radius_mm)?;
                let h = positive("heightMm", *height_mm)?;
                Ok(vec![ConvexSolid::cylinder(
                    &frame(*origin, *axis)?,
                    r,
                    0.0,
                    h,
                    segments(r, *s),
                )?])
            }
            Self::Prism {
                origin,
                axis,
                points,
                holes,
                height_mm,
            } => {
                let h = positive("heightMm", *height_mm)?;
                if !holes.is_empty() || !is_convex(points) {
                    return Err(Error::invalid(
                        "prism",
                        "subtract needs a convex ring without holes",
                    ));
                }
                Ok(vec![ConvexSolid::prism(&frame(*origin, *axis)?, points, 0.0, h)?])
            }
            Self::Countersink {
                origin,
                axis,
                shaft_diameter_mm,
                head_diameter_mm,
                angle_deg,
                depth_mm,
                segments: s,
            } => {
                let (rs, rh) = (
                    positive("shaftDiameterMm", *shaft_diameter_mm)? / 2.0,
                    positive("headDiameterMm", *head_diameter_mm)? / 2.0,
                );
                let depth = positive("depthMm", *depth_mm)?;
                if rh <= rs {
                    return Err(Error::invalid("headDiameterMm", "must be above shaftDiameterMm"));
                }
                let angle = angle_deg.unwrap_or(90.0);
                if !(30.0..=150.0).contains(&angle) {
                    return Err(Error::invalid("angleDeg", "must be between 30 and 150"));
                }
                let cone = (rh - rs) / (angle.to_radians() / 2.0).m_tan();
                let f = frame(*origin, *axis)?;
                let n = segments(rh, *s);
                let slope = (rh - rs) / cone;
                let top = -OVERSHOOT_MM;
                let head = frustum(&f, rh + slope * OVERSHOOT_MM, rs, top, cone, n)?;
                let mut out = vec![head];
                if depth > cone {
                    out.push(ConvexSolid::cylinder(&f, rs, cone - OVERSHOOT_MM, depth, n)?);
                }
                Ok(out)
            }
        }
    }
}
