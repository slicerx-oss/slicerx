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
#[repr(u8)]
pub enum VolumeRole {
    /// Cut out of the object. (The numbers are what the raw parts format writes.)
    Negative = 0,
    /// No support inside it.
    SupportBlocker = 1,
    /// Support wherever the object's underside is inside it, at any angle.
    SupportEnforcer = 2,
    /// The object prints with other settings inside it.
    Modifier = 3,
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
    pub fn single_on(mesh: Mesh, area: [f64; 4], height_mm: f64) -> Self {
        match on_area(area, height_mm) {
            Some((bed, center)) => Self::single_at(mesh, bed, Some(center)),
            // A profile without a printable area leaves the default bed.
            None => Self::single(mesh),
        }
    }

    fn single_at(mesh: Mesh, bed: Bed, center: Option<[f32; 2]>) -> Self {
        let transform = placed(mesh.bounds(), bed, center);
        let object = item_object(mesh, 0, transform);
        Self {
            bed,
            objects: vec![object],
        }
    }

    /// The build items of one 3MF plate ([`crate::api::load_3mf_items`]) as objects of their own, so each is one
    /// label, one footprint and one body for the collision check, on the printable area `(min_x, min_y, max_x,
    /// max_y)` of a profile (the default bed without an area) as `placement` puts them: a slicer project's where the
    /// file puts them, from the area's front left corner; any other 3MF's where the file puts them, the plate as a
    /// whole centered on the area and set down on z = 0, as [`Plate::single_on`] places one mesh. The parts, cuts,
    /// modifiers and support volumes of an item stay in its object. Ids are `object-1` on in build order; each object
    /// takes its item's name and painted brim ears, and the plate's settings (its `settings` are `Null`).
    pub fn items_on(items: Vec<Mesh>, area: [f64; 4], height_mm: f64, placement: ItemsPlacement) -> Self {
        let (bed, center, origin) = match on_area(area, height_mm) {
            Some((bed, center)) => (bed, Some(center), Some(area_corner(area))),
            None => (Bed::default(), None, None),
        };
        let placement = match (placement, origin) {
            (ItemsPlacement::Kept([x, y]), Some([ox, oy])) => ItemsPlacement::Kept([x + ox, y + oy]),
            (other, _) => other,
        };
        let transforms = items_transforms(&items, bed, center, placement);
        Self {
            bed,
            objects: items
                .into_iter()
                .zip(transforms)
                .enumerate()
                .map(|(k, (mesh, transform))| item_object(mesh, k, transform))
                .collect(),
        }
    }
}

/// The bed of a profile's printable area `(min_x, min_y, max_x, max_y)` and the area's center; `None` when the
/// profile has no area.
#[allow(clippy::cast_possible_truncation, reason = "bed sizes in mm fit f32")]
fn on_area(area: [f64; 4], height_mm: f64) -> Option<(Bed, [f32; 2])> {
    if !(area[2] > area[0] && area[3] > area[1]) {
        return None;
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
    Some((bed, center))
}

/// The front left corner `(min_x, min_y)` of a printable area `(min_x, min_y, max_x, max_y)`.
#[allow(clippy::cast_possible_truncation, reason = "bed coordinates in mm fit f32")]
fn area_corner(area: [f64; 4]) -> [f32; 2] {
    [area[0] as f32, area[1] as f32]
}

/// Object `k` (0-based) of a plate: one mesh with the volumes and part settings its file marks.
fn item_object(mesh: Mesh, k: usize, transform: [f32; 16]) -> PlateObject {
    PlateObject {
        id: format!("object-{}", k + 1),
        name: mesh.name.clone(),
        volumes: file_volumes(&mesh),
        part_settings: mesh.part_settings.clone(),
        brim_points: mesh.brim_points.clone(),
        mesh: Arc::new(mesh),
        transform,
        slot_overrides: Vec::new(),
        settings: serde_json::Value::Null,
    }
}

/// The cuts, modifiers and support volumes a loaded file marks in `mesh`, as volumes of the object that holds it:
/// they share the object's transform, as they share the space of its parts.
pub fn file_volumes(mesh: &Mesh) -> Vec<PlateVolume> {
    mesh.volumes
        .iter()
        .map(|v| PlateVolume {
            name: v.part.name.clone(),
            role: v.role,
            mesh: Arc::new(Mesh {
                name: v.part.name.clone(),
                parts: vec![v.part.clone()],
                ..Mesh::default()
            }),
            transform: None,
            settings: v.settings.clone(),
        })
        .collect()
}

/// A translation that centers the mesh on the bed and drops it to z = 0.
pub fn centered_transform(mesh: &Mesh, bed: Bed) -> [f32; 16] {
    placed(mesh.bounds(), bed, None)
}

/// The one translation every build item of a 3MF plate takes: the items as a whole centered on the bed (on `center`
/// when given) and set down on z = 0, so each keeps its place in the file and to the others. The request path gives it
/// to the objects a project splits into, and [`Plate::items_on`] to its own.
pub fn items_transform(items: &[Mesh], bed: Bed, center: Option<[f32; 2]>) -> [f32; 16] {
    let bounds = items
        .iter()
        .filter_map(Mesh::bounds)
        .reduce(|(mut lo, mut hi), (l, h)| {
            for (a, b) in lo.iter_mut().zip(l) {
                *a = a.min(b);
            }
            for (a, b) in hi.iter_mut().zip(h) {
                *a = a.max(b);
            }
            (lo, hi)
        });
    placed(bounds, bed, center)
}

/// Where the build items of a 3MF plate go on the bed ([`crate::api::load_3mf_placement`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ItemsPlacement {
    /// As one group, centered on the bed and set down on z = 0: a 3MF that is no slicer's project (a CAD export, a
    /// downloaded model), as the app places one.
    Centered,
    /// Where the project puts them, moved by `[x, y]` mm from the file's build space to the bed's (the plate's place
    /// in the project's layout and its printable area's front left corner taken off, the bed's added). An item is set
    /// down on z = 0 only when the file's rounding leaves it a hair under the bed, as the app keeps a slicer project's
    /// positions.
    Kept([f32; 2]),
}

/// How far under the bed a project's build item may sit and still be one resting on it: slicers write transforms to
/// a few decimals, so an item turned on its side can land a few thousandths of a mm low. One set lower stays there.
const SETTLE_MM: f32 = 0.05;

/// The transform of each build item of a 3MF plate, in order: [`items_transform`] for every item when `placement`
/// centers them, else each item kept where the file puts it, moved by the placement.
pub fn items_transforms(
    items: &[Mesh],
    bed: Bed,
    center: Option<[f32; 2]>,
    placement: ItemsPlacement,
) -> Vec<[f32; 16]> {
    match placement {
        ItemsPlacement::Centered => vec![items_transform(items, bed, center); items.len()],
        ItemsPlacement::Kept([x, y]) => items
            .iter()
            .map(|m| {
                let mut t = IDENTITY;
                t[12] = x;
                t[13] = y;
                if let Some((lo, _)) = m.bounds()
                    && lo[2] < 0.0
                    && lo[2] > -SETTLE_MM
                {
                    t[14] = -lo[2];
                }
                t
            })
            .collect(),
    }
}

/// The front left corner of the printable area a config sets (`printable_area`, Orca's `"XxY"` points or `[x, y]`
/// pairs): where the plate's 0, 0 sits on the machine. `[0, 0]` without an area.
pub fn area_origin(config: &serde_json::Value) -> [f32; 2] {
    config
        .get("printable_area")
        .and_then(crate::config::area_points)
        .and_then(|pts| corner(&pts))
        .unwrap_or([0.0, 0.0])
}

/// The front left corner of an area's points, `None` for fewer than three.
#[allow(clippy::cast_possible_truncation, reason = "bed coordinates in mm fit f32")]
pub(crate) fn corner(pts: &[[f64; 2]]) -> Option<[f32; 2]> {
    (pts.len() >= 3).then(|| {
        let x = pts.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
        let y = pts.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
        [x as f32, y as f32]
    })
}

/// A translation that puts the middle of `bounds` on the bed's center (or `center`) and their bottom on z = 0.
fn placed(bounds: Option<([f32; 3], [f32; 3])>, bed: Bed, center: Option<[f32; 2]>) -> [f32; 16] {
    let Some((lo, hi)) = bounds else {
        return IDENTITY;
    };
    let [cx, cy] = center.unwrap_or([bed.width_mm / 2.0, bed.depth_mm / 2.0]);
    let mut t = IDENTITY;
    t[12] = cx - f32::midpoint(lo[0], hi[0]);
    t[13] = cy - f32::midpoint(lo[1], hi[1]);
    t[14] = -lo[2];
    t
}
