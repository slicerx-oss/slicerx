// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Checks on a parsed mesh, the STL to 3MF conversion and the preview image.

use std::fmt::Write as _;

use sx_core::mesh::Mesh;

use crate::archive::write_zip;
use crate::limits::Limits;
use crate::reject::Reject;

/// What the library records about a model.
#[derive(Debug, Clone, PartialEq)]
pub struct MeshFacts {
    pub triangle_count: u64,
    pub min: [f32; 3],
    pub max: [f32; 3],
}

/// Rejects a mesh with no geometry, non-finite coordinates, out-of-range
/// indices, too many triangles or absurd size.
pub fn check_mesh(mesh: &Mesh, limits: &Limits) -> Result<MeshFacts, Reject> {
    let triangles = mesh.triangle_count();
    if triangles == 0 {
        return Err(Reject::new("mesh_empty", "the model has no triangles"));
    }
    if triangles > limits.max_triangles {
        return Err(Reject::new(
            "too_many_triangles",
            format!(
                "the model has {triangles} triangles, the limit is {}",
                limits.max_triangles
            ),
        ));
    }
    let vertices: usize = mesh.parts.iter().map(|p| p.positions.len()).sum();
    if vertices > limits.max_triangles.saturating_mul(3) {
        return Err(Reject::new(
            "too_many_triangles",
            "the model has more vertices than the limit allows",
        ));
    }
    let mut area = 0.0_f64;
    for part in &mesh.parts {
        if part.positions.iter().any(|p| p.iter().any(|c| !c.is_finite())) {
            return Err(Reject::new(
                "mesh_not_finite",
                "the model has coordinates that are not finite numbers",
            ));
        }
        for t in &part.triangles {
            let mut v = [[0.0_f64; 3]; 3];
            for (dst, &i) in v.iter_mut().zip(t) {
                let p = part
                    .positions
                    .get(i as usize)
                    .ok_or_else(|| Reject::new("mesh_invalid", "a triangle refers to a missing vertex"))?;
                *dst = [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])];
            }
            let a = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
            let b = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
            let c = [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ];
            area += 0.5 * (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
        }
    }
    if area <= 0.0 || !area.is_finite() {
        return Err(Reject::new(
            "mesh_empty",
            "every triangle of the model is degenerate, so it has no surface",
        ));
    }
    let (min, max) = mesh
        .bounds()
        .ok_or_else(|| Reject::new("mesh_empty", "the model has no vertices"))?;
    let extent = (0..3).map(|i| max[i] - min[i]).fold(0.0_f32, f32::max);
    if !extent.is_finite() || extent > limits.max_extent_mm {
        return Err(Reject::new(
            "mesh_too_large",
            format!("the model is larger than {} mm", limits.max_extent_mm),
        ));
    }
    Ok(MeshFacts {
        triangle_count: triangles as u64,
        min,
        max,
    })
}

/// Writes the mesh as a plain 3MF: one object, one build item, millimeters.
pub fn mesh_to_3mf(mesh: &Mesh) -> Result<Vec<u8>, Reject> {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<model unit=\"millimeter\" xml:lang=\"en-US\" \
xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">\n \
<metadata name=\"Application\">SlicerX</metadata>\n <resources>\n",
    );
    for (n, part) in mesh.parts.iter().enumerate() {
        let id = n + 1;
        let _ = write!(
            xml,
            "  <object id=\"{id}\" type=\"model\">\n   <mesh>\n    <vertices>\n"
        );
        for p in &part.positions {
            let _ = writeln!(xml, "     <vertex x=\"{}\" y=\"{}\" z=\"{}\"/>", p[0], p[1], p[2]);
        }
        xml.push_str("    </vertices>\n    <triangles>\n");
        for t in &part.triangles {
            let _ = writeln!(
                xml,
                "     <triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>",
                t[0], t[1], t[2]
            );
        }
        xml.push_str("    </triangles>\n   </mesh>\n  </object>\n");
    }
    xml.push_str(" </resources>\n <build>\n");
    for n in 0..mesh.parts.len() {
        let _ = writeln!(xml, "  <item objectid=\"{}\"/>", n + 1);
    }
    xml.push_str(" </build>\n</model>\n");
    let types = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n \
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\n \
<Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\n</Types>\n";
    let rels = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n \
<Relationship Id=\"rel0\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\" Target=\"/3D/3dmodel.model\"/>\n</Relationships>\n";
    write_zip(
        [
            ("[Content_Types].xml", false, types.as_bytes()),
            ("_rels/.rels", false, rels.as_bytes()),
            ("3D/3dmodel.model", false, xml.as_bytes()),
        ]
        .into_iter(),
    )
}
