// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! resume a failed print from a layer

use crate::convex;
use crate::error::{Error, Result};
use crate::mesh::TriMesh;
use crate::vec3::Plane;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResumeRequest {
    pub measured_height_mm: Option<f64>,
    /// layer number the printer showed when it stopped, counting from 1. That layer is printed again, since it is likely incomplete
    pub failed_layer: Option<u32>,
    pub first_layer_height_mm: f64,
    pub layer_height_mm: f64,
    pub layer_tops_mm: Option<Vec<f64>>,
    /// how far a measurement may sit above a layer top and still count that layer as done
    pub tolerance_mm: Option<f64>,
    pub include_remaining_mesh: bool,
}

impl Default for ResumeRequest {
    fn default() -> Self {
        Self {
            measured_height_mm: None,
            failed_layer: None,
            first_layer_height_mm: 0.2,
            layer_height_mm: 0.2,
            layer_tops_mm: None,
            tolerance_mm: None,
            include_remaining_mesh: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePlan {
    pub resume_layer: u32,
    pub resume_layer_number: u32,
    pub layer_count: u32,
    pub remaining_layers: u32,
    pub printed_height_mm: f64,
    pub resume_z_mm: f64,
    pub warnings: Vec<String>,
    #[serde(skip)]
    pub remaining: Option<TriMesh>,
}

pub fn layer_top(i: u32, first: f64, h: f64) -> f64 {
    if i == 0 { first } else { first + f64::from(i) * h }
}

pub fn layer_count(height: f64, first: f64, h: f64) -> u32 {
    if height <= 0.0 || first <= 0.0 || h <= 0.0 {
        return 0;
    }
    let mut i = 0u32;
    loop {
        let bottom = if i == 0 { 0.0 } else { layer_top(i - 1, first, h) };
        if f64::midpoint(bottom, layer_top(i, first, h)) >= height || i > 200_000 {
            return i;
        }
        i += 1;
    }
}

fn tops_for(req: &ResumeRequest, height: f64) -> Result<Vec<f64>> {
    let (first, h) = (req.first_layer_height_mm, req.layer_height_mm);
    if let Some(t) = &req.layer_tops_mm {
        let ascending = t.windows(2).all(|w| w.first() < w.last());
        let ok = t.first().is_some_and(|&x| x > 0.0) && t.iter().all(|x| x.is_finite()) && ascending;
        if !ok {
            return Err(Error::invalid(
                "layerTopsMm",
                "layer tops must be positive and strictly ascending",
            ));
        }
        return Ok(t.clone());
    }
    if !(first > 0.0 && h > 0.0) {
        return Err(Error::invalid("resume", "layer heights must be positive"));
    }
    Ok((0..layer_count(height, first, h))
        .map(|i| layer_top(i, first, h))
        .collect())
}

pub fn plan(mesh: &TriMesh, req: &ResumeRequest) -> Result<ResumePlan> {
    let h = req.layer_height_mm;
    let Some(b) = mesh.bounds() else {
        return Err(Error::invalid("resume", "the mesh is empty"));
    };
    let bed = b.min[2];
    let tops = tops_for(req, b.max[2] - bed)?;
    #[allow(clippy::cast_possible_truncation, reason = "layer counts stay far below 2^32")]
    let count = tops.len() as u32;
    let top = |i: u32| tops.get(i as usize).copied().unwrap_or(0.0);
    let tol = req
        .tolerance_mm
        .unwrap_or_else(|| {
            // half the thinnest layer, so a layer is never skipped
            if req.layer_tops_mm.is_none() {
                return h * 0.5;
            }
            let mut prev = 0.0;
            let thinnest = tops
                .iter()
                .map(|&t| {
                    let d = t - prev;
                    prev = t;
                    d
                })
                .fold(f64::INFINITY, f64::min);
            thinnest * 0.5
        })
        .max(0.0);
    let mut warnings = Vec::new();
    let from_height = req
        .measured_height_mm
        .map(|mh| u32::try_from(tops.partition_point(|&t| t <= mh + tol)).unwrap_or(count));
    let from_layer = req.failed_layer.map(|n| n.saturating_sub(1));
    let resume = match (from_height, from_layer) {
        (Some(a), Some(b)) => {
            if a.abs_diff(b) > 1 {
                warnings.push(format!(
                    "the measured height points to layer {} but the printer reported layer {}; using the measurement",
                    a + 1,
                    b + 1
                ));
            }
            a
        }
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => {
            return Err(Error::invalid(
                "resume",
                "give the measured height or the layer the print stopped on",
            ));
        }
    };
    if resume >= count {
        return Err(Error::invalid(
            "resume",
            format!("layer {} is past the last layer ({count})", resume + 1),
        ));
    }
    if resume == 0 {
        warnings.push("nothing usable is on the bed: start the print again from the beginning".to_owned());
    }
    let printed = if resume == 0 { 0.0 } else { top(resume - 1) };
    let remaining = if !req.include_remaining_mesh {
        None
    } else if resume == 0 {
        Some(mesh.clone())
    } else {
        Some(convex::split_by_plane(mesh, &Plane::horizontal(bed + printed))?.1)
    };
    Ok(ResumePlan {
        resume_layer: resume,
        resume_layer_number: resume + 1,
        layer_count: count,
        remaining_layers: count - resume,
        printed_height_mm: printed,
        resume_z_mm: top(resume),
        warnings,
        remaining,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    #[test]
    fn layer_count_matches_the_core_reference_plate() {
        assert_eq!(layer_count(101.53, 0.2, 0.2), 508);
        assert_eq!(layer_count(10.0, 0.2, 0.2), 50);
        assert_eq!(layer_count(10.05, 0.3, 0.2), 50);
    }

    #[test]
    fn measured_height_picks_the_next_layer() {
        let cube = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
        let r = plan(
            &cube,
            &ResumeRequest {
                measured_height_mm: Some(7.43),
                ..ResumeRequest::default()
            },
        )
        .unwrap();
        assert_eq!(r.resume_layer, 37);
        assert!((r.printed_height_mm - 7.4).abs() < 1e-9);
        assert!((r.resume_z_mm - 7.6).abs() < 1e-9);
        assert_eq!(r.layer_count, 100);
        let rest = r.remaining.unwrap();
        assert!(rest.edge_report().is_watertight());
        assert!((rest.volume() - 20.0 * 20.0 * 12.6).abs() < 1e-6);
    }

    #[test]
    fn variable_layer_tops_are_used_as_given() {
        let cube = build::box_mesh([0.0; 3], [20.0, 20.0, 2.0]);
        let tops = vec![0.2, 0.4, 0.7, 1.0, 1.25, 1.5, 1.7, 2.0];
        let r = plan(
            &cube,
            &ResumeRequest {
                measured_height_mm: Some(1.02),
                layer_tops_mm: Some(tops.clone()),
                ..ResumeRequest::default()
            },
        )
        .unwrap();
        assert_eq!((r.resume_layer, r.layer_count), (4, 8));
        assert!((r.printed_height_mm - 1.0).abs() < 1e-12 && (r.resume_z_mm - 1.25).abs() < 1e-12);
        let rest = r.remaining.unwrap();
        assert!((rest.volume() - 400.0).abs() < 1e-6);
        let bad = ResumeRequest {
            failed_layer: Some(2),
            layer_tops_mm: Some(vec![0.2, 0.2]),
            ..ResumeRequest::default()
        };
        assert!(plan(&cube, &bad).is_err());
    }

    #[test]
    fn printer_layer_number_reprints_that_layer() {
        let cube = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
        let r = plan(
            &cube,
            &ResumeRequest {
                failed_layer: Some(57),
                include_remaining_mesh: false,
                ..ResumeRequest::default()
            },
        )
        .unwrap();
        assert_eq!(r.resume_layer, 56);
        assert_eq!(r.resume_layer_number, 57);
        assert!((r.resume_z_mm - 11.4).abs() < 1e-9);
        assert!(r.remaining.is_none());
    }

    #[test]
    fn disagreement_is_reported_and_past_the_top_fails() {
        let cube = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
        let r = plan(
            &cube,
            &ResumeRequest {
                measured_height_mm: Some(5.0),
                failed_layer: Some(40),
                include_remaining_mesh: false,
                ..ResumeRequest::default()
            },
        )
        .unwrap();
        assert_eq!(r.warnings.len(), 1);
        assert!(
            plan(
                &cube,
                &ResumeRequest {
                    measured_height_mm: Some(25.0),
                    ..ResumeRequest::default()
                }
            )
            .is_err()
        );
    }
}
