// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! split a model into the fewest parts that fit a build volume

// axis indices are 0, 1 or 2 throughout
#![allow(clippy::indexing_slicing)]

use crate::cut::{self, ConnectorSpec, CutOptions};
use crate::error::{Error, Result};
use crate::mesh::TriMesh;
use crate::vec3::{Plane, V3};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SplitOptions {
    pub build_volume_mm: V3,
    pub margin_mm: f64,
    pub allow_rotate_z: bool,
    pub connector: Option<ConnectorSpec>,
    pub max_parts: usize,
    pub samples_per_cut: usize,
}

impl Default for SplitOptions {
    fn default() -> Self {
        Self {
            build_volume_mm: [256.0, 256.0, 256.0],
            margin_mm: 2.0,
            allow_rotate_z: true,
            connector: None,
            max_parts: 64,
            samples_per_cut: 24,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SplitPart {
    pub mesh: TriMesh,
    pub size_mm: V3,
    pub rotate_z_90: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedCut {
    pub axis: usize,
    pub offset_mm: f64,
    pub seam_length_mm: f64,
    pub section_area_mm2: f64,
    pub islands: usize,
}

#[derive(Debug, Clone, Default)]
pub struct SplitResult {
    pub parts: Vec<SplitPart>,
    pub cuts: Vec<PlannedCut>,
    pub extras: Vec<TriMesh>,
    pub warnings: Vec<String>,
}

pub fn fits(size: V3, limit: V3, allow_rotate: bool) -> Option<bool> {
    if size[2] > limit[2] {
        return None;
    }
    if size[0] <= limit[0] && size[1] <= limit[1] {
        return Some(false);
    }
    (allow_rotate && size[0] <= limit[1] && size[1] <= limit[0]).then_some(true)
}

pub fn split_to_fit(mesh: &TriMesh, opts: &SplitOptions) -> Result<SplitResult> {
    mesh.validate("split input")?;
    let limit = opts.build_volume_mm.map(|v| v - opts.margin_mm);
    if limit
        .iter()
        .any(|&v| v.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater))
    {
        return Err(Error::invalid(
            "split",
            "the build volume minus the margin must be positive",
        ));
    }
    let mut out = SplitResult::default();
    let mut queue = vec![mesh.clone()];
    let cut_opts = CutOptions {
        connector: opts.connector.clone(),
    };
    while let Some(part) = queue.pop() {
        let Some(b) = part.bounds() else {
            continue;
        };
        let size = b.size();
        if let Some(rot) = fits(size, limit, opts.allow_rotate_z) {
            out.parts.push(SplitPart {
                mesh: part,
                size_mm: size,
                rotate_z_90: rot,
            });
            continue;
        }
        if out.parts.len() + queue.len() + 2 > opts.max_parts {
            return Err(Error::geometry(
                "split",
                format!("more than {} parts would be needed", opts.max_parts),
            ));
        }
        let axis = worst_axis(size, limit, opts.allow_rotate_z);
        let lim = axis_limit(size, limit, axis, opts.allow_rotate_z);
        let ext = size[axis];
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "small positive count"
        )]
        let pieces = ((ext / lim).ceil() as usize).max(2);
        let lo = (ext - (pieces - 1) as f64 * lim).max(ext * 0.02);
        let hi = lim.min(ext * 0.98);
        let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, hi) };
        let best = best_plane(
            &part,
            axis,
            b.min[axis] + lo,
            b.min[axis] + hi,
            opts.samples_per_cut.max(1),
        );
        let plane = axis_plane(axis, best.offset_mm);
        let r = cut::plane_cut(&part, &plane, &cut_opts)?;
        out.warnings.extend(r.report.warnings.iter().cloned());
        out.extras.extend(r.extras);
        out.cuts.push(best);
        for piece in [r.below, r.above] {
            for comp in piece.components() {
                if comp.volume().abs() > 1e-9 {
                    queue.push(comp);
                }
            }
        }
    }
    out.parts
        .sort_by(|a, b| b.mesh.volume().total_cmp(&a.mesh.volume()));
    Ok(out)
}

fn axis_plane(axis: usize, offset: f64) -> Plane {
    let mut n = [0.0; 3];
    n[axis % 3] = 1.0;
    Plane { normal: n, offset }
}

fn axis_limit(size: V3, limit: V3, axis: usize, allow_rotate: bool) -> f64 {
    match axis {
        0 | 1 if allow_rotate => {
            let straight = (size[0] / limit[0]).max(size[1] / limit[1]);
            let turned = (size[0] / limit[1]).max(size[1] / limit[0]);
            if turned < straight {
                if axis == 0 { limit[1] } else { limit[0] }
            } else {
                limit[axis]
            }
        }
        _ => limit[axis % 3],
    }
}

fn worst_axis(size: V3, limit: V3, allow_rotate: bool) -> usize {
    (0..3)
        .max_by(|&a, &b| {
            let ra = size[a] / axis_limit(size, limit, a, allow_rotate);
            let rb = size[b] / axis_limit(size, limit, b, allow_rotate);
            ra.total_cmp(&rb)
        })
        .unwrap_or(2)
}

fn best_plane(mesh: &TriMesh, axis: usize, lo: f64, hi: f64, samples: usize) -> PlannedCut {
    let mut best: Option<(f64, PlannedCut)> = None;
    let mut scored = Vec::with_capacity(samples);
    for i in 0..samples {
        let t = if samples == 1 {
            0.5
        } else {
            i as f64 / (samples - 1) as f64
        };
        let offset = lo + (hi - lo) * t;
        let s = cut::section(mesh, &axis_plane(axis, offset));
        scored.push(PlannedCut {
            axis,
            offset_mm: offset,
            seam_length_mm: s.perimeter(),
            section_area_mm2: s.area(),
            islands: s.islands(),
        });
    }
    let max_area = scored
        .iter()
        .map(|c| c.section_area_mm2)
        .fold(0.0, f64::max)
        .max(1e-9);
    let max_seam = scored
        .iter()
        .map(|c| c.seam_length_mm)
        .fold(0.0, f64::max)
        .max(1e-9);
    for c in scored {
        let sliver = if c.section_area_mm2 < 0.15 * max_area {
            0.5
        } else {
            0.0
        };
        let score = c.seam_length_mm / max_seam + 0.15 * c.islands.saturating_sub(1) as f64 + sliver;
        if best.as_ref().is_none_or(|(s, _)| score < *s) {
            best = Some((score, c));
        }
    }
    best.map(|(_, c)| c).unwrap_or(PlannedCut {
        axis,
        offset_mm: f64::midpoint(lo, hi),
        seam_length_mm: 0.0,
        section_area_mm2: 0.0,
        islands: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;
    use crate::poly2d::{self, Polygon};
    use crate::vec3::Frame;

    fn opts(v: V3) -> SplitOptions {
        SplitOptions {
            build_volume_mm: v,
            margin_mm: 0.0,
            ..SplitOptions::default()
        }
    }

    #[test]
    fn a_part_that_fits_is_left_alone() {
        let b = build::box_mesh([0.0; 3], [50.0, 50.0, 50.0]);
        let r = split_to_fit(&b, &opts([100.0, 100.0, 100.0])).unwrap();
        assert_eq!(r.parts.len(), 1);
        assert!(r.cuts.is_empty());
    }

    #[test]
    fn turning_avoids_a_cut() {
        let b = build::box_mesh([0.0; 3], [150.0, 80.0, 40.0]);
        let r = split_to_fit(&b, &opts([100.0, 180.0, 100.0])).unwrap();
        assert_eq!(r.parts.len(), 1);
        assert!(r.parts[0].rotate_z_90);
    }

    #[test]
    fn tall_box_needs_the_fewest_cuts() {
        let b = build::box_mesh([0.0; 3], [60.0, 60.0, 500.0]);
        let r = split_to_fit(&b, &opts([180.0, 180.0, 180.0])).unwrap();
        assert_eq!(r.parts.len(), 3);
        assert_eq!(r.cuts.len(), 2);
        for p in &r.parts {
            assert!(p.size_mm[2] <= 180.0 + 1e-9);
            assert!(p.mesh.edge_report().is_watertight());
        }
        let total: f64 = r.parts.iter().map(|p| p.mesh.volume()).sum();
        assert!((total - 60.0 * 60.0 * 500.0).abs() < 1e-3);
    }

    #[test]
    fn cut_lands_on_the_neck() {
        let mut m = build::box_mesh([0.0, 0.0, 0.0], [80.0, 80.0, 90.0]);
        let neck = Polygon::simple(poly2d::circle([40.0, 40.0], 8.0, 32));
        let mut n = build::extrude(&[neck], &Frame::WORLD, 90.0, 110.0).unwrap();
        m.append(&n);
        n = build::box_mesh([0.0, 0.0, 110.0], [80.0, 80.0, 200.0]);
        m.append(&n);
        let m = m.welded();
        let r = split_to_fit(&m, &opts([150.0, 150.0, 150.0])).unwrap();
        assert_eq!(r.cuts.len(), 1);
        let z = r.cuts[0].offset_mm;
        assert!((90.0..=110.0).contains(&z), "cut at {z}");
    }

    #[test]
    fn wide_and_tall_torus_splits_on_two_axes() {
        let t = build::torus([0.0; 3], 100.0, 20.0, 96, 32);
        let r = split_to_fit(&t, &opts([130.0, 250.0, 100.0])).unwrap();
        for p in &r.parts {
            assert!(fits(p.size_mm, [130.0, 250.0, 100.0], true).is_some());
            assert!(p.mesh.edge_report().is_watertight());
        }
        assert!(r.parts.len() >= 2);
    }
}
