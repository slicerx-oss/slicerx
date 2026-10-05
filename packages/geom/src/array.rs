// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! linear and circular arrays

use crate::boolean::{self, BoolOp, BooleanOptions, BooleanReport};
use crate::error::{Error, Result};
use crate::mesh::{Aabb, TriMesh};
use crate::vec3::{self, V3};
use crate::xform::{self, Mat4};
use serde::{Deserialize, Serialize};

pub const MAX_COPIES: usize = 2000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ArraySpec {
    Linear {
        count: usize,
        /// offset between neighbors in mm, for example `[25, 0, 0]`
        step: V3,
        #[serde(default)]
        count2: Option<usize>,
        #[serde(default)]
        step2: Option<V3>,
    },
    Circular {
        count: usize,
        center: V3,
        /// default +Z
        #[serde(default)]
        axis: Option<V3>,
        #[serde(default)]
        angle_deg: Option<f64>,
        #[serde(default)]
        rotate_copies: Option<bool>,
    },
}

pub fn transforms(spec: &ArraySpec) -> Result<Vec<Mat4>> {
    let check = |n: usize, what: &'static str| {
        if n == 0 {
            Err(Error::invalid(what, "must be at least 1"))
        } else {
            Ok(n)
        }
    };
    match spec {
        ArraySpec::Linear {
            count,
            step,
            count2,
            step2,
        } => {
            let n1 = check(*count, "count")?;
            let n2 = check(count2.unwrap_or(1), "count2")?;
            if n1.saturating_mul(n2) > MAX_COPIES {
                return Err(Error::invalid("count", format!("at most {MAX_COPIES} copies")));
            }
            let s2 = step2.unwrap_or([0.0; 3]);
            if !step.iter().chain(&s2).all(|c| c.is_finite()) {
                return Err(Error::invalid("step", "must be finite"));
            }
            if n2 > 1 && vec3::len(s2) == 0.0 {
                return Err(Error::invalid("step2", "needed for a grid"));
            }
            let mut out = Vec::with_capacity(n1 * n2);
            for j in 0..n2 {
                for i in 0..n1 {
                    let d = vec3::add(vec3::scale(*step, i as f64), vec3::scale(s2, j as f64));
                    out.push(xform::translation(d));
                }
            }
            Ok(out)
        }
        ArraySpec::Circular {
            count,
            center,
            axis,
            angle_deg,
            ..
        } => {
            let n = check(*count, "count")?;
            if n > MAX_COPIES {
                return Err(Error::invalid("count", format!("at most {MAX_COPIES} copies")));
            }
            let axis = vec3::normalize(axis.unwrap_or([0.0, 0.0, 1.0]))
                .ok_or_else(|| Error::invalid("axis", "must be a non-zero vector"))?;
            let sweep = angle_deg.unwrap_or(360.0);
            if !(sweep.is_finite() && sweep.abs() <= 360.0) {
                return Err(Error::invalid("angleDeg", "between -360 and 360"));
            }
            let full = (sweep.abs() - 360.0).abs() < 1e-9;
            let step = if full {
                sweep / n as f64
            } else if n > 1 {
                sweep / (n - 1) as f64
            } else {
                0.0
            };
            Ok((0..n)
                .map(|i| xform::rotation_about(*center, axis, (step * i as f64).to_radians()))
                .collect())
        }
    }
}

pub fn transforms_for(mesh: &TriMesh, spec: &ArraySpec) -> Result<Vec<Mat4>> {
    let ts = transforms(spec)?;
    if let ArraySpec::Circular {
        rotate_copies: Some(false),
        ..
    } = spec
    {
        let c = mesh.bounds().map_or([0.0; 3], |b| b.center());
        return Ok(ts
            .iter()
            .map(|t| xform::translation(vec3::sub(xform::apply(t, c), c)))
            .collect());
    }
    Ok(ts)
}

/// copies whose bounds overlap another copy's (a quick check; touching bounds count when they overlap by more than 1 micron)
pub fn overlapping(mesh: &TriMesh, ts: &[Mat4]) -> bool {
    let boxes: Vec<Aabb> = ts
        .iter()
        .filter_map(|t| xform::transformed(mesh, t).bounds())
        .collect();
    let eps = 1e-3;
    boxes.iter().enumerate().any(|(i, a)| {
        boxes.iter().skip(i + 1).any(|b| {
            a.min
                .iter()
                .zip(&a.max)
                .zip(b.min.iter().zip(&b.max))
                .all(|((amin, amax), (bmin, bmax))| amin + eps < *bmax && bmin + eps < *amax)
        })
    })
}

pub fn merged(mesh: &TriMesh, ts: &[Mat4], opts: &BooleanOptions) -> Result<(TriMesh, BooleanReport)> {
    let copies: Vec<TriMesh> = ts.iter().map(|t| xform::transformed(mesh, t)).collect();
    boolean::boolean(&copies, &[], BoolOp::Union, opts)
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "transforms are built from exact values")]
mod tests {
    use super::*;
    use crate::build;

    #[test]
    fn linear_grid_and_merge() {
        let m = build::box_mesh([0.0; 3], [10.0, 10.0, 5.0]);
        let spec = ArraySpec::Linear {
            count: 3,
            step: [12.0, 0.0, 0.0],
            count2: Some(2),
            step2: Some([0.0, 12.0, 0.0]),
        };
        let ts = transforms(&spec).unwrap();
        assert_eq!(ts.len(), 6);
        assert_eq!(ts[0], xform::IDENTITY);
        assert!(!overlapping(&m, &ts));
        let (u, r) = merged(&m, &ts, &BooleanOptions::default()).unwrap();
        assert_eq!(r.shells, 6);
        assert!((u.volume() - 3000.0).abs() < 1e-6);
        let close = transforms(&ArraySpec::Linear {
            count: 3,
            step: [8.0, 0.0, 0.0],
            count2: None,
            step2: None,
        })
        .unwrap();
        assert!(overlapping(&m, &close));
        let (u, r) = merged(&m, &close, &BooleanOptions::default()).unwrap();
        assert_eq!(r.shells, 1);
        assert!((u.volume() - 26.0 * 10.0 * 5.0).abs() < 1e-6);
    }

    #[test]
    fn circular_full_and_partial() {
        let m = build::box_mesh([20.0, -2.0, 0.0], [24.0, 2.0, 4.0]);
        let spec = ArraySpec::Circular {
            count: 4,
            center: [0.0; 3],
            axis: None,
            angle_deg: None,
            rotate_copies: None,
        };
        let ts = transforms_for(&m, &spec).unwrap();
        let c = xform::apply(&ts[1], [22.0, 0.0, 2.0]);
        assert!(vec3::len(vec3::sub(c, [0.0, 22.0, 2.0])) < 1e-9);
        let spec = ArraySpec::Circular {
            count: 3,
            center: [0.0; 3],
            axis: Some([0.0, 0.0, 1.0]),
            angle_deg: Some(90.0),
            rotate_copies: Some(false),
        };
        let ts = transforms_for(&m, &spec).unwrap();
        let c = xform::apply(&ts[2], [22.0, 0.0, 2.0]);
        assert!(vec3::len(vec3::sub(c, [0.0, 22.0, 2.0])) < 1e-9);
        assert!((ts[1][0] - 1.0).abs() < 1e-12 && ts[1][1].abs() < 1e-12);
        assert!(
            transforms(&ArraySpec::Circular {
                count: 0,
                center: [0.0; 3],
                axis: None,
                angle_deg: None,
                rotate_copies: None
            })
            .is_err()
        );
    }
}
