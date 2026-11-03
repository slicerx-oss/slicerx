// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A request's 3MF projects made into the objects the engine slices: each build item of the plate a project object
//! names becomes an object of its own ([`split_projects`]). `sx slice --request` and the cloud service share it; each
//! reads the project files its own way ([`ProjectFiles`]).

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;

use crate::api::{self, ObjectSpec, PlatePlacement, SliceRequest};
use crate::plate::ItemsPlacement;
use crate::{Mesh, Result, SliceWarning};

/// Where [`split_projects`] reads a request's project files.
pub trait ProjectFiles {
    /// The project file an object's mesh key names and the plate the key picks (`None`: the project's first), or
    /// `None` when the key names no 3MF project.
    fn project(&self, key: &str) -> Option<(String, Option<u32>)>;
    /// The bytes of project file `file`, as [`ProjectFiles::project`] names it.
    fn bytes(&self, file: &str) -> Result<Arc<Vec<u8>>>;
    /// True when the request writes paint over mesh `key`: such a mesh stays one object, so the paint's part indices
    /// are those of the mesh as loaded.
    fn painted(&self, _key: &str) -> bool {
        false
    }
    /// The note for a project named without a plate that has more plates than the one sliced.
    fn plates_note(&self, file: &str, plates: usize, sliced: u32) -> String {
        format!("{file} has {plates} plates; slicing plate {sliced} ({file}#N picks another)")
    }
}

/// A project the request names without a plate that has more plates than the one sliced (the result's
/// `projectPlates`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectPlate {
    pub file: String,
    pub plates: usize,
    pub sliced: u32,
    pub text: String,
}

/// What [`split_projects`] made of a request's projects.
#[derive(Debug, Default)]
pub struct SplitProjects {
    /// The meshes of the objects it made, under their new keys (a plate of one item keeps its key, with the item's
    /// mesh).
    pub meshes: HashMap<String, Arc<Mesh>>,
    /// A note for each project named without a plate that has more plates than the one sliced.
    pub plates: Vec<ProjectPlate>,
    /// A warning for each tool change a project keeps that does not apply ([`api::load_3mf_marks`]).
    pub skipped: Vec<SliceWarning>,
    /// Set when the request names one project plate whose prime tower spot is not certain, so the project's spot is
    /// not kept.
    pub tower_unsure: Option<String>,
}

/// A 3MF plate given without a transform becomes one object per build item ([`api::load_3mf_items`]), so print by
/// object, its clearance checks and the object labels see the objects and not one merged mesh. A slicer project's
/// items stay where the file puts them (on the machine of the request's `printable_area`), any other 3MF's where the
/// file puts them with the plate centered on the bed ([`api::load_3mf_placement`]), as the app and
/// `sx slice <file.3mf>` place them. With `plate.placement` `keep`, any 3MF's items stay where the file puts them, from
/// the front left corner of the printable area, and a 3MF kept whole (given paint, volumes or brim ears) is moved the
/// same way; the engine then refuses a part off the printable area. The marks and tool changes a project sets on the
/// plate's layers go into the request unless it brings its own, and a request naming one project plate keeps the
/// project's prime tower spot, as the app does.
pub fn split_projects(req: &mut SliceRequest, files: &dyn ProjectFiles) -> Result<SplitProjects> {
    let mut split = SplitProjects::default();
    // The project plates the request names: the file, the plate's number and its entry in per-plate lists.
    let mut projects: Vec<(String, u32, Option<usize>)> = Vec::new();
    let bed = req.plate.bed.map_or_else(api::Bed::default, |b| api::Bed {
        width_mm: b.width_mm,
        depth_mm: b.depth_mm,
        height_mm: b.height_mm,
    });
    let keep = req.plate.placement == PlatePlacement::Keep;
    let mut out = Vec::with_capacity(req.plate.objects.len());
    for o in std::mem::take(&mut req.plate.objects) {
        let key = o.mesh_ref();
        let Some((file, plate)) = files.project(&key) else {
            out.push(o);
            continue;
        };
        let plain =
            o.transform.is_none() && o.volumes.is_empty() && o.brim_points.is_empty() && !files.painted(&key);
        if keep && !plain && o.transform.is_none() {
            // Kept whole, in the file's build space: moved as its items would be, with no recentering.
            let transform = Some(kept_whole(files, &file, plate, bed, &req.config)?);
            out.push(ObjectSpec { transform, ..o });
            continue;
        }
        if !plain {
            out.push(o);
            continue;
        }
        let bytes = files.bytes(&file)?;
        let (found, plates) = api::load_3mf_items_counted(&bytes, &file, plate)?;
        let Some((plate_no, items)) = found else {
            // loading it names the plate the file does not have
            out.push(o);
            continue;
        };
        if plate.is_none() && plates > 1 && !split.plates.iter().any(|n| n.file == file) {
            split.plates.push(ProjectPlate {
                text: files.plates_note(&file, plates, plate_no),
                file: file.clone(),
                plates,
                sliced: plate_no,
            });
        }
        split.skipped.extend(take_project_marks(req, &bytes, plate_no));
        let found = api::load_3mf_placement(&bytes, &file, plate_no, [bed.width_mm, bed.depth_mm])?;
        let project = found != ItemsPlacement::Centered;
        let placement = if project || keep {
            ItemsPlacement::Kept(kept_offset(found, &req.config))
        } else {
            found
        };
        if project && !projects.iter().any(|(f, n, _)| *f == file && *n == plate_no) {
            projects.push((
                file.clone(),
                plate_no,
                api::load_3mf_plate_index(&bytes, &file, plate_no)?,
            ));
        }
        // A plate that is no project is centered on the bed, which starts where the printable area does.
        let middle = crate::plate::bed_middle(bed, &req.config);
        let at = crate::plate::items_transforms(&items, bed, Some(middle), placement);
        if items.len() < 2 {
            // One object keeps its key, centered as the plate or where the project puts it; the ears the file paints
            // on it go with it, and its mesh is named after its object, not the file.
            let mut o = o;
            if let Some(one) = items.into_iter().next() {
                o.brim_points.clone_from(&one.brim_points);
                if placement != ItemsPlacement::Centered {
                    o.transform = at.first().map(|t| t.to_vec());
                }
                split.meshes.insert(key, Arc::new(one));
            }
            out.push(o);
            continue;
        }
        for ((k, mesh), at) in items.into_iter().enumerate().zip(at) {
            let id = format!("{key}@{}", k + 1);
            let mut one = o.clone();
            one.id = format!("{}-{}", if o.id.is_empty() { "object" } else { &o.id }, k + 1);
            one.name.clone_from(&mesh.name);
            one.mesh = serde_json::Value::String(id.clone());
            one.transform = Some(at.to_vec());
            one.brim_points.clone_from(&mesh.brim_points);
            split.meshes.insert(id, Arc::new(mesh));
            out.push(one);
        }
    }
    req.plate.objects = out;
    // A request naming one project plate keeps the project's tower spot its settings carry, as the app does: the plate's
    // own entry of the per-plate lists, with auto placement off unless the request sets it.
    if let [(file, plate_no, index)] = projects.as_slice()
        && let Some(config) = req.config.as_object_mut()
    {
        let auto_set = config.contains_key("prime_tower_auto_position");
        if api::keep_plate_tower(config, *index, true, auto_set) == api::PlateTower::Unsure {
            split.tower_unsure = Some(format!(
                "which of {file}'s tower spots is plate {plate_no}'s is not certain (its plates are not numbered 1, 2, \
                 3 in order, or the list has no entry for it), so the project's spot is not kept"
            ));
        }
    }
    Ok(split)
}

/// The marks and tool changes project `bytes` sets on the layers of plate `plate_no` go into `req` unless it brings its
/// own; returns a note for each of the project's tool changes that does not apply, unless the request brings its own.
fn take_project_marks(req: &mut SliceRequest, bytes: &[u8], plate_no: u32) -> Vec<SliceWarning> {
    let marks = api::load_3mf_marks(bytes, plate_no);
    if req.options.layer_gcode.is_none() && !marks.gcode.is_empty() {
        req.options.layer_gcode = Some(marks.gcode);
    }
    if req.options.tool_changes.is_some() {
        return Vec::new();
    }
    if !marks.tool_changes.is_empty() {
        req.options.tool_changes = Some(marks.tool_changes);
    }
    marks.skipped
}

/// The transform of a 3MF plate kept as one object under `placement` `keep` (it has paint, volumes or brim ears of the
/// request): a move from the file's build space onto the machine, as [`kept_offset`] moves its items.
fn kept_whole(
    files: &dyn ProjectFiles,
    file: &str,
    plate: Option<u32>,
    bed: api::Bed,
    config: &serde_json::Value,
) -> Result<Vec<f32>> {
    let bytes = files.bytes(file)?;
    let plate_no = match plate {
        Some(n) => n,
        None => api::load_3mf_items(&bytes, file, None)?.map_or(1, |(n, _)| n),
    };
    let [x, y] = kept_offset(
        api::load_3mf_placement(&bytes, file, plate_no, [bed.width_mm, bed.depth_mm])?,
        config,
    );
    let mut t = crate::plate::IDENTITY;
    t[12] = x;
    t[13] = y;
    Ok(t.to_vec())
}

/// How far a 3MF plate's items move from the file's build space onto the machine when they are kept where the file puts
/// them: a project's own placement (its plate's place in the project taken off), or none for any other 3MF, plus the
/// front left corner of the request's printable area.
fn kept_offset(found: ItemsPlacement, config: &serde_json::Value) -> [f32; 2] {
    let [x, y] = match found {
        ItemsPlacement::Kept(at) => at,
        ItemsPlacement::Centered => [0.0, 0.0],
    };
    let [ox, oy] = crate::plate::area_origin(config);
    [x + ox, y + oy]
}
