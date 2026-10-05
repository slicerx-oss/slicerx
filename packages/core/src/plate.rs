// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The build plate: bed size and placed objects.

use crate::mesh::Mesh;
use std::sync::Arc;

/// Printable volume in millimeters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bed {
    pub width_mm: f32,
    pub depth_mm: f32,
    pub height_mm: f32,
}

impl Default for Bed {
    fn default() -> Self {
        Self {
            width_mm: 256.0,
            depth_mm: 256.0,
            height_mm: 250.0,
        }
    }
}

/// What a volume of an object does, as in `OrcaSlicer`'s volume types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeRole {
    /// Cut out of the object.
    Negative,
    /// No support inside it.
    SupportBlocker,
    /// Support wherever the object's underside is inside it, at any angle.
    SupportEnforcer,
    /// The object prints with other settings inside it.
    Modifier,
}

/// A volume of an object that is not part of the printed model.
#[derive(Debug, Clone)]
pub struct PlateVolume {
    pub name: String,
    pub role: VolumeRole,
    pub mesh: Arc<Mesh>,
    /// 4x4 column-major transform in mm; the object's own when absent.
    pub transform: Option<[f32; 16]>,
    /// Orca key overrides of a modifier; `Null` for the other roles.
    pub settings: serde_json::Value,
}

/// A mesh placed on the plate.
#[derive(Debug, Clone)]
pub struct PlateObject {
    pub id: String,
    pub name: String,
    pub mesh: Arc<Mesh>,
    /// 4x4 column-major transform, mm, Z up, origin at the bed's front left corner.
    pub transform: [f32; 16],
    /// Part name to filament slot, when the plate differs from the file.
    pub slot_overrides: Vec<(String, u8)>,
    /// Orca key overrides of single parts, by part name.
    pub part_settings: Vec<(String, serde_json::Value)>,
    /// Negative parts and support blockers and enforcers of this object.
    pub volumes: Vec<PlateVolume>,
    /// Orca key overrides for this object alone; `Null` when it uses the plate's settings.
    pub settings: serde_json::Value,
    /// Painted brim ears (`brim_type` = `painted`): x, y, z in the mesh's space, mm, and the head radius, mm.
    pub brim_points: Vec<[f32; 4]>,
}

impl PlateObject {
    /// Slot for a part after overrides.
    pub fn slot_for(&self, part_name: &str, file_slot: u8) -> u8 {
        self.slot_overrides
            .iter()
            .find(|(n, _)| n == part_name)
            .map_or(file_slot, |(_, s)| *s)
            .max(1)
    }

    /// Applies the transform to a point.
    pub fn apply(&self, p: [f32; 3]) -> [f64; 3] {
        Self::apply_with(&self.transform, p)
    }

    /// Applies a 4x4 column-major transform to a point.
    pub fn apply_with(transform: &[f32; 16], p: [f32; 3]) -> [f64; 3] {
        let m = transform.map(f64::from);
        let [x, y, z] = p.map(f64::from);
        std::array::from_fn(|r| {
            let at = |c: usize| m.get(c * 4 + r).copied().unwrap_or(0.0);
            at(0) * x + at(1) * y + at(2) * z + at(3)
        })
    }
}

/// Everything that gets sliced together.
#[derive(Debug, Clone, Default)]
pub struct Plate {
    pub bed: Bed,
    pub objects: Vec<PlateObject>,
}

/// The identity transform.
pub const IDENTITY: [f32; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

impl Plate {
    /// One mesh centered on the default 256 mm bed, resting on z = 0.
    pub fn single(mesh: Mesh) -> Self {
        Self::single_at(mesh, Bed::default(), None)
    }

    /// One mesh centered on the printable area `(min_x, min_y, max_x, max_y)` of a profile, resting on z = 0.
    #[allow(clippy::cast_possible_truncation, reason = "bed sizes in mm fit f32")]
    pub fn single_on(mesh: Mesh, area: [f64; 4], height_mm: f64) -> Self {
        // A profile without a printable area leaves the default bed.
        if !(area[2] > area[0] && area[3] > area[1]) {
            return Self::single(mesh);
        }
        let bed = Bed {
            width_mm: (area[2] - area[0]) as f32,
            depth_mm: (area[3] - area[1]) as f32,
            height_mm: height_mm as f32,
        };
        let center = [
            f64::midpoint(area[0], area[2]) as f32,
            f64::midpoint(area[1], area[3]) as f32,
        ];
        Self::single_at(mesh, bed, Some(center))
    }

    fn single_at(mesh: Mesh, bed: Bed, center: Option<[f32; 2]>) -> Self {
        let mut transform = centered_transform(&mesh, bed);
        if let Some(c) = center
            && let Some((lo, hi)) = mesh.bounds()
        {
            transform[12] = c[0] - f32::midpoint(lo[0], hi[0]);
            transform[13] = c[1] - f32::midpoint(lo[1], hi[1]);
        }
        let object = PlateObject {
            id: "object-1".to_owned(),
            name: mesh.name.clone(),
            mesh: Arc::new(mesh),
            transform,
            slot_overrides: Vec::new(),
            part_settings: Vec::new(),
            volumes: Vec::new(),
            settings: serde_json::Value::Null,
            brim_points: Vec::new(),
        };
        Self {
            bed,
            objects: vec![object],
        }
    }
}

/// A translation that centers the mesh on the bed and drops it to z = 0.
pub fn centered_transform(mesh: &Mesh, bed: Bed) -> [f32; 16] {
    let Some((lo, hi)) = mesh.bounds() else {
        return IDENTITY;
    };
    let mut t = IDENTITY;
    t[12] = bed.width_mm / 2.0 - f32::midpoint(lo[0], hi[0]);
    t[13] = bed.depth_mm / 2.0 - f32::midpoint(lo[1], hi[1]);
    t[14] = -lo[2];
    t
}
