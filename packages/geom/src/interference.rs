// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! interference between two closed bodies: the volume they share, or the clearance between them

use crate::boolean::{self, BoolOp, BooleanOptions};
use crate::error::{Error, Result};
use crate::fit;
use crate::mesh::TriMesh;
use crate::vec3::V3;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// shared volume under this counts as touching, not interfering
pub const OVERLAP_MM3: f64 = 1e-3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interference {
    pub interferes: bool,
    pub overlap_mm3: f64,
    /// the smallest distance between the two surfaces; 0 when they touch or interfere
    pub clearance_mm: f64,
    /// the closest pair of points, one on each body; absent when they interfere
    pub from: Option<V3>,
    pub to: Option<V3>,
}

pub fn interference(a: &TriMesh, b: &TriMesh) -> Result<Interference> {
    let (a, b) = (closed(a, "a")?, closed(b, "b")?);
    let (a, b) = (a.as_ref(), b.as_ref());
    let (d, p, q, crossing) =
        fit::closest(a, b).ok_or_else(|| Error::invalid("a", "an empty body has nothing to measure"))?;
    // apart: no boolean needed
    if d > 0.0 && !crossing {
        return Ok(Interference {
            interferes: false,
            overlap_mm3: 0.0,
            clearance_mm: d,
            from: Some(p),
            to: Some(q),
        });
    }
    let (shared, _) = boolean::boolean(
        std::slice::from_ref(a),
        std::slice::from_ref(b),
        BoolOp::Intersection,
        &BooleanOptions::default(),
    )?;
    let v = shared.volume().max(0.0);
    let interferes = v > OVERLAP_MM3;
    Ok(Interference {
        interferes,
        overlap_mm3: if interferes { v } else { 0.0 },
        clearance_mm: 0.0,
        from: (!interferes).then_some(p),
        to: (!interferes).then_some(q),
    })
}

/// the body, welded when it comes with its corners split per face, once it is closed
fn closed<'m>(m: &'m TriMesh, name: &'static str) -> Result<Cow<'m, TriMesh>> {
    m.validate(name)?;
    if m.triangles.is_empty() {
        return Err(Error::invalid(name, "the body is empty"));
    }
    if m.edge_report().is_watertight() {
        return Ok(Cow::Borrowed(m));
    }
    let w = m.welded();
    let e = w.edge_report();
    if !e.is_watertight() {
        return Err(Error::invalid(
            name,
            format!(
                "the body is not closed ({} open, {} shared by more than two faces, {} flipped edges); repair it first",
                e.boundary_edges, e.non_manifold_edges, e.flipped_edges
            ),
        ));
    }
    Ok(Cow::Owned(w))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{box_mesh, cylinder};
    use crate::vec3::Frame;

    #[test]
    fn overlapping_boxes_share_their_overlap() {
        let a = box_mesh([0.0; 3], [10.0; 3]);
        let b = box_mesh([7.0, 2.0, 0.0], [17.0, 12.0, 10.0]);
        let r = interference(&a, &b).unwrap();
        assert!(r.interferes);
        // 3 by 8 by 10
        assert!((r.overlap_mm3 - 240.0).abs() < 1e-6, "{r:?}");
        assert!(r.from.is_none());
    }

    #[test]
    fn boxes_apart_report_their_gap() {
        let a = box_mesh([0.0; 3], [10.0; 3]);
        let b = box_mesh([10.3, 0.0, 0.0], [20.0, 10.0, 10.0]);
        let r = interference(&a, &b).unwrap();
        assert!(!r.interferes);
        assert!((r.clearance_mm - 0.3).abs() < 1e-9, "{r:?}");
        // far apart too
        let c = box_mesh([0.0, 0.0, 60.0], [10.0, 10.0, 70.0]);
        assert!((interference(&a, &c).unwrap().clearance_mm - 50.0).abs() < 1e-9);
    }

    #[test]
    fn touching_boxes_do_not_interfere() {
        let a = box_mesh([0.0; 3], [10.0; 3]);
        let b = box_mesh([10.0, 0.0, 0.0], [20.0, 10.0, 10.0]);
        let r = interference(&a, &b).unwrap();
        assert!(!r.interferes, "{r:?}");
        assert!(r.clearance_mm.abs() < 1e-12);
    }

    #[test]
    fn a_pin_in_a_hole_keeps_its_radial_clearance() {
        let n = 64;
        let f = Frame::WORLD;
        let block = box_mesh([-10.0, -10.0, 0.0], [10.0, 10.0, 10.0]);
        let bore = cylinder(&f, 5.2, -1.0, 11.0, n);
        let (holed, _) =
            boolean::boolean(&[block], &[bore], BoolOp::Difference, &BooleanOptions::default()).unwrap();
        let pin = cylinder(&f, 5.0, -5.0, 15.0, n);
        let r = interference(&holed, &pin).unwrap();
        assert!(!r.interferes, "{r:?}");
        // both are 64 sided with their corners lined up: a pin corner to the bore's facets beside it
        let want = 0.2 * crate::fm::Fm::m_cos(std::f64::consts::PI / n as f64);
        assert!(
            (r.clearance_mm - want).abs() < 1e-6,
            "{} vs {want}",
            r.clearance_mm
        );
        assert!((r.clearance_mm - 0.2).abs() < 0.01);
        // a pin too fat for the bore
        let fat = cylinder(&f, 5.4, 0.0, 10.0, n);
        assert!(interference(&holed, &fat).unwrap().interferes);
    }

    #[test]
    fn a_body_inside_another_interferes_by_its_volume() {
        let a = box_mesh([0.0; 3], [10.0; 3]);
        let b = box_mesh([2.0; 3], [4.0; 3]);
        let r = interference(&a, &b).unwrap();
        assert!(r.interferes);
        assert!((r.overlap_mm3 - 8.0).abs() < 1e-6, "{r:?}");
    }

    #[test]
    #[ignore = "timing, run with --release -- --ignored --nocapture"]
    fn timing_on_two_100k_tori() {
        let t = |x: f64, z: f64| crate::build::torus([x, 0.0, z], 20.0, 6.0, 250, 200);
        let a = t(0.0, 0.0);
        assert_eq!(a.triangles.len(), 100_000);
        for (what, b) in [
            ("overlapping", t(15.0, 0.0)),
            ("0.3 mm apart", t(0.0, 12.3)),
            ("far apart", t(100.0, 0.0)),
        ] {
            let t0 = std::time::Instant::now();
            let r = interference(&a, &b).unwrap();
            println!(
                "{what}: {:.0} ms, overlap {:.1} mm3, clearance {:.4} mm",
                t0.elapsed().as_secs_f64() * 1e3,
                r.overlap_mm3,
                r.clearance_mm
            );
        }
    }

    #[test]
    fn open_or_empty_bodies_are_refused() {
        let a = box_mesh([0.0; 3], [10.0; 3]);
        let mut open = a.clone();
        open.triangles.pop();
        open.faces = None;
        let e = interference(&a, &open).unwrap_err().to_string();
        assert!(e.contains("not closed"), "{e}");
        // corners split per face still make a closed body
        let split = TriMesh::new(
            a.triangles
                .iter()
                .flat_map(|t| t.map(|i| a.positions[i as usize]))
                .collect(),
            (0..12).map(|k| [3 * k, 3 * k + 1, 3 * k + 2]).collect(),
        );
        let far = box_mesh([20.0; 3], [30.0; 3]);
        assert!((interference(&split, &far).unwrap().clearance_mm - 10.0 * 3f64.sqrt()).abs() < 1e-9);
        let e = interference(&TriMesh::default(), &a).unwrap_err().to_string();
        assert!(e.contains("empty"), "{e}");
    }
}
