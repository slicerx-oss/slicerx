// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sleipnir planned here: the layer tops for a request that turns `smart_layer` on and sends none, from the same
//! sx-geom planner and the same plate mesh the app plans with (every part in bed coordinates, rounded to f32).

use crate::config::PrintConfig;
use crate::plate::{Plate, PlateObject};
use sx_geom::layers::{LayerMode, LayerOptions, plan_layers};
use sx_geom::mesh::TriMesh;

/// The mode a request asks for in its own config, or `None` when it leaves `smart_layer` out or turns it off. The
/// schema's default is left alone, so a host that sends no `smart_layer` slices at `layer_height` as before.
pub(crate) fn requested(request_config: &serde_json::Value) -> Option<LayerMode> {
    match request_config.get("smart_layer")?.as_str()? {
        "quality" => Some(LayerMode::Quality),
        "strength" => Some(LayerMode::Strength),
        _ => None,
    }
}

/// Every printed part of the plate as one mesh, as the app's `plateMesh` builds it.
fn plate_mesh(plate: &Plate) -> TriMesh {
    let mut positions = Vec::new();
    let mut triangles = Vec::new();
    for obj in &plate.objects {
        let m = obj.transform.map(f64::from);
        let det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2])
            + m[8] * (m[1] * m[6] - m[5] * m[2]);
        for part in &obj.mesh.parts {
            let base = u32::try_from(positions.len()).unwrap_or(u32::MAX);
            #[allow(clippy::cast_possible_truncation, reason = "the app's baked mesh is f32")]
            positions.extend(part.positions.iter().map(|p| {
                PlateObject::apply_with(&obj.transform, *p).map(|c| f64::from(c as f32))
            }));
            // A mirroring transform flips the winding; turn triangles back so normals point out.
            triangles.extend(part.triangles.iter().map(|t| {
                let t = t.map(|i| base + i);
                if det < 0.0 { [t[0], t[2], t[1]] } else { t }
            }));
        }
    }
    TriMesh {
        positions,
        triangles,
        faces: None,
    }
}

/// The layer tops, first layer first, or `None` when the plan is not possible; the slice then keeps `layer_height`.
pub(crate) fn plan(plate: &Plate, config: &PrintConfig, mode: LayerMode) -> Option<Vec<f64>> {
    let nozzle = config.nozzle_diameter;
    let opts = LayerOptions {
        min_height_mm: Some(config.raw_number("smart_layer_min_height", 0.15)),
        max_height_mm: Some(config.raw_number("smart_layer_max_height", nozzle * 0.75)),
        first_layer_mm: config.initial_layer_print_height,
        ..LayerOptions::default()
    };
    let tops = plan_layers(&plate_mesh(plate), nozzle, mode, &opts).ok()?.layer_tops_mm;
    (tops.len() > 1).then_some(tops)
}
