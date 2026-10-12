// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! 3MF loading: the core specification plus what Bambu Studio and `OrcaSlicer`
//! write (objects split into component files through the production
//! extension, and per-part filament slots in `Metadata/model_settings.config`).
//!
//! The container is read with a small ZIP reader (stored and deflate entries,
//! through `miniz_oxide`) and the XML with a tag scanner that reads element
//! names and attributes, which is all the 3MF model format needs. Every build
//! item becomes one or more parts with its transform applied, so positions are
//! in the file's build space. Painted multi-material (per-triangle colors) is
//! not read yet.

use crate::error::{Error, Result};
use crate::mesh::{Mesh, MeshPart, MeshVolume};
use crate::plate::VolumeRole;
use std::collections::HashMap;

/// Largest uncompressed entry accepted (a guard against ZIP bombs).
const MAX_ENTRY: usize = 1 << 30;
/// Deepest component nesting followed.
const MAX_DEPTH: u32 = 16;
/// Work one file may ask of the component resolver: one unit per object visited, plus its vertices and
/// triangles for every copy placed. Components can repeat a mesh at every level, so a few lines of XML can
/// otherwise ask for billions of copies. The 1.2 million triangle benchmark mesh costs about 1.8 million.
const MAX_WORK: u64 = 40_000_000;

/// Loads the first plate of a Bambu or Orca project, or every build item of
/// a plain 3MF.
pub(crate) fn load(bytes: &[u8], name: &str) -> Result<Mesh> {
    load_plates(bytes, name)?
        .into_iter()
        .next()
        .map(|(_, m)| m)
        .ok_or_else(|| Error::mesh(name, "the 3MF file has no printable objects"))
}

/// Every plate as its own mesh, `(plate number, mesh)` in plate order. A
/// plain 3MF (no plate metadata) is one plate numbered 1.
pub(crate) fn load_plates(bytes: &[u8], name: &str) -> Result<Vec<(u32, Mesh)>> {
    Ok(load_plate_objects(bytes, name)?
        .into_iter()
        .map(|(plate, objects)| {
            (plate, {
                let mut mesh = Mesh {
                    name: name.to_owned(),
                    ..Mesh::default()
                };
                // One mesh holds one object's settings: they stay when every object has the same, and are
                // noted otherwise (each object's printed parts still take its region settings).
                let first = objects.first().map(|o| o.settings.clone()).unwrap_or_default();
                if objects.iter().all(|o| o.settings == first) {
                    mesh.settings = first;
                } else {
                    mesh.notes.push(
                        "objects on this plate have different object settings; settings beyond walls, infill and speeds apply only when each object is sliced as its own (a request without a transform does that)"
                            .to_owned(),
                    );
                }
                for o in objects {
                    mesh.parts.extend(o.parts);
                    mesh.volumes.extend(o.volumes);
                    mesh.part_settings.extend(o.part_settings);
                    for n in o.notes {
                        if !mesh.notes.contains(&n) {
                            mesh.notes.push(n);
                        }
                    }
                }
                mesh
            })
        })
        .collect())
}

/// Every plate with each build item as a mesh of its own, named after its object, in plate order.
/// Positions are in the file's build space, like [`load_plates`]. The file is read by `sx-geom`'s 3MF reader;
/// a build without it (the WebAssembly engine) reads it with [`load_plate_objects_legacy`].
pub(crate) fn load_plate_objects(bytes: &[u8], name: &str) -> Result<Vec<(u32, Vec<Mesh>)>> {
    #[cfg(feature = "import")]
    return from_geom(bytes, name);
    #[cfg(not(feature = "import"))]
    return load_plate_objects_legacy(bytes, name);
}

/// The engine's own 3MF reader, kept until the one in `sx-geom` has replaced it everywhere: the format corpus
/// (`scripts/format-corpus`) holds the two to the same meshes and the same G-code.
pub(crate) fn load_plate_objects_legacy(bytes: &[u8], name: &str) -> Result<Vec<(u32, Vec<Mesh>)>> {
    let zip = Zip::open(bytes).map_err(|e| Error::mesh(name, e))?;
    let root = zip
        .read("_rels/.rels")
        .ok()
        .and_then(|rels| {
            tags(&rels)
                .filter(|t| t.name == "Relationship")
                .find(|t| t.attr("Type").is_some_and(|ty| ty.ends_with("/3dmodel")))
                .and_then(|t| t.attr("Target").map(|s| s.trim_start_matches('/').to_owned()))
        })
        .unwrap_or_else(|| "3D/3dmodel.model".to_owned());
    let mut models: HashMap<String, Model> = HashMap::new();
    let main = parse_model(&zip.read(&root).map_err(|e| Error::mesh(name, e))?)
        .map_err(|e| Error::mesh(name, refused(&root, e)))?;
    let settings = zip.read("Metadata/model_settings.config").unwrap_or_default();
    let slots = slot_map(&settings);
    let meta = project_parts(&settings);
    let plate_of = plate_map(&settings);
    let names = object_names(&settings);
    let scale = main.unit_scale;
    let mut plates: std::collections::BTreeMap<u32, Vec<Mesh>> = std::collections::BTreeMap::new();
    let mut work = MAX_WORK;
    let mut costs = HashMap::new();
    for item in &main.build {
        let plate = plate_of.get(&item.object).copied().unwrap_or(1);
        let mut parts = Vec::new();
        let mut volumes = Vec::new();
        let mut with_settings = Vec::new();
        let mut notes = Vec::new();
        let mut ctx = Resolve {
            zip: &zip,
            models: &mut models,
            parts: &mut parts,
            volumes: &mut volumes,
            with_settings: &mut with_settings,
            notes: &mut notes,
            meta: &meta,
            slots: &slots,
            name,
            work: &mut work,
        };
        // the whole item is costed from its object tree first, so a repeating file is refused before any copy
        let cost = ctx.cost(&main, &root, item.object, 0, &mut costs)?;
        *ctx.work = ctx
            .work
            .checked_sub(cost)
            .ok_or_else(|| Error::mesh(name, "3MF components repeat their meshes too many times to load"))?;
        ctx.object(&main, &root, item.object, item.transform, item.object, 0)?;
        if parts.is_empty() {
            continue;
        }
        if (scale - 1.0).abs() > f32::EPSILON {
            // Positions and the painted pieces decoded on them move to millimeters together.
            for p in parts.iter_mut().chain(volumes.iter_mut().map(|v| &mut v.part)) {
                let facets = p
                    .paint
                    .iter_mut()
                    .chain(p.support_paint.iter_mut())
                    .chain(p.seam_paint.iter_mut())
                    .chain(p.fuzzy_paint.iter_mut())
                    .flat_map(|f| f.v.iter_mut());
                for v in p.positions.iter_mut().chain(facets) {
                    for c in v.iter_mut() {
                        *c *= scale;
                    }
                }
            }
        }
        let own = names
            .get(&item.object)
            .cloned()
            .or_else(|| main.objects.get(&item.object).map(|o| o.name.clone()))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| name.to_owned());
        // Settings go by part name; a part sharing its name with another is named after its id as well.
        let mut part_settings = Vec::with_capacity(with_settings.len());
        for (k, id, settings) in with_settings {
            let shared = parts
                .get(k)
                .is_some_and(|p| parts.iter().filter(|q| q.name == p.name).count() > 1);
            if let Some(p) = parts.get_mut(k) {
                if shared {
                    p.name = format!("{} #{id}", p.name);
                }
                part_settings.push((p.name.clone(), settings));
            }
        }
        for k in &meta.dropped {
            notes.push(format!(
                "{k} in the project's object or part settings is not used (custom G-code and scripts come from the printer settings)"
            ));
        }
        let settings = meta
            .object(item.object)
            .filter(|m| !m.is_empty())
            .map_or(serde_json::Value::Null, |m| serde_json::Value::Object(m.clone()));
        plates.entry(plate).or_default().push(Mesh {
            name: own,
            parts,
            volumes,
            part_settings,
            notes,
            settings,
        });
    }
    if plates.is_empty() {
        return Err(Error::mesh(name, "the 3MF file has no printable objects"));
    }
    Ok(plates.into_iter().collect())
}

/// A project read by `sx-geom` (`format::read_3mf`) as the meshes the engine slices: printable build items with a
/// printed part, each part placed on the plate with its paint decoded, the volumes that do not print, the part and
/// object settings, and the notes the legacy reader gives, worded the same.
#[cfg(feature = "import")]
fn from_geom(bytes: &[u8], name: &str) -> Result<Vec<(u32, Vec<Mesh>)>> {
    use sx_geom::format::{Layout, PartKind};
    let project = sx_geom::format::read_3mf(bytes).map_err(|e| match e {
        sx_geom::Error::Invalid { why, .. } => Error::mesh(name, why),
        other => Error::mesh(name, other.to_string()),
    })?;
    // PrusaSlicer's volumes are read by the legacy reader as one printed mesh; this keeps that until the switch
    if project.layout == Layout::Prusa {
        return load_plate_objects_legacy(bytes, name);
    }
    let scale = project.unit_scale;
    // custom G-code and keys a file may never set stay out of object and part settings, named once each
    let never = |k: &str| k.contains("gcode") || crate::preflight::is_never_imported(k);
    let mut dropped: Vec<String> = Vec::new();
    for o in &project.objects {
        for (k, _) in o
            .settings
            .iter()
            .chain(o.parts.iter().flat_map(|p| p.settings.iter()))
        {
            if never(k) && !dropped.contains(k) {
                dropped.push(k.clone());
            }
        }
    }
    let to_map = |list: &[(String, String)]| -> serde_json::Map<String, serde_json::Value> {
        list.iter()
            .filter(|(k, _)| !never(k))
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect()
    };
    let mut plates: std::collections::BTreeMap<u32, Vec<Mesh>> = std::collections::BTreeMap::new();
    for o in project.objects {
        if !o.printable {
            continue;
        }
        let object = to_map(&o.settings);
        let mut parts: Vec<MeshPart> = Vec::new();
        let mut volumes: Vec<MeshVolume> = Vec::new();
        let mut with_settings = Vec::new();
        let mut notes: Vec<String> = Vec::new();
        // the name a part without one gets, numbered as the legacy reader numbers it: once per mesh placed
        let mut fallback = String::new();
        let mut leaf: Option<(u32, Vec<[f32; 12]>)> = None;
        for p in o.parts {
            let same_leaf = p.range.is_some()
                && leaf
                    .as_ref()
                    .is_some_and(|(id, chain)| *id == p.id && *chain == p.chain);
            if !same_leaf {
                fallback = if p.mesh_name.is_empty() {
                    format!("part {}", parts.len() + volumes.len() + 1)
                } else {
                    p.mesh_name.clone()
                };
                leaf = Some((p.id, p.chain.clone()));
            }
            let slot = p.slot.or(o.slot).unwrap_or(1).max(1);
            let info_name = (p.name != p.mesh_name || p.range.is_some())
                .then(|| p.name.clone())
                .filter(|n| !n.is_empty());
            let shown = info_name.clone().unwrap_or_else(|| fallback.clone());
            let part_name = if p.range.is_some() {
                shown.clone()
            } else {
                fallback.clone()
            };
            let role = match p.kind {
                PartKind::Normal => None,
                PartKind::Negative => Some(VolumeRole::Negative),
                PartKind::Modifier => Some(VolumeRole::Modifier),
                PartKind::SupportBlocker => Some(VolumeRole::SupportBlocker),
                PartKind::SupportEnforcer => Some(VolumeRole::SupportEnforcer),
            };
            if let Some(other) = &p.kind_text {
                notes.push(format!(
                    "{shown}: part type {other} is not one this engine knows; it prints as a normal part"
                ));
            }
            let own = to_map(&p.settings);
            for k in object.keys().chain(own.keys()) {
                if crate::config::READ_KEYS.contains(&k.as_str())
                    || crate::config::FUZZY_KEYS.contains(&k.as_str())
                {
                    continue;
                }
                let line = format!("{k} is not applied by this engine (project part or object setting)");
                if !notes.contains(&line) {
                    notes.push(line);
                }
            }
            let part = geom_part(&p, &o.transform, slot, part_name);
            match role {
                None => {
                    let mut settings = object.clone();
                    settings.extend(own);
                    if !settings.is_empty() {
                        with_settings.push((parts.len(), p.id, serde_json::Value::Object(settings)));
                    }
                    parts.push(part);
                }
                Some(role) => {
                    let settings = if role == VolumeRole::Modifier {
                        let mut s = object.clone();
                        s.extend(own);
                        serde_json::Value::Object(s)
                    } else {
                        if !own.is_empty() {
                            notes.push(format!(
                                "{shown}: settings on a {} are not used ({})",
                                role_name(role),
                                own.keys().cloned().collect::<Vec<_>>().join(", ")
                            ));
                        }
                        serde_json::Value::Null
                    };
                    volumes.push(MeshVolume {
                        role,
                        part: MeshPart { name: shown, ..part },
                        settings,
                    });
                }
            }
        }
        if parts.is_empty() {
            continue;
        }
        if (scale - 1.0).abs() > f32::EPSILON {
            for p in parts.iter_mut().chain(volumes.iter_mut().map(|v| &mut v.part)) {
                let facets = p
                    .paint
                    .iter_mut()
                    .chain(p.support_paint.iter_mut())
                    .chain(p.seam_paint.iter_mut())
                    .chain(p.fuzzy_paint.iter_mut())
                    .flat_map(|f| f.v.iter_mut());
                for v in p.positions.iter_mut().chain(facets) {
                    for c in v.iter_mut() {
                        *c *= scale;
                    }
                }
            }
        }
        let mut part_settings = Vec::with_capacity(with_settings.len());
        for (k, id, settings) in with_settings {
            let shared = parts
                .get(k)
                .is_some_and(|p| parts.iter().filter(|q| q.name == p.name).count() > 1);
            if let Some(p) = parts.get_mut(k) {
                if shared {
                    p.name = format!("{} #{id}", p.name);
                }
                part_settings.push((p.name.clone(), settings));
            }
        }
        for k in &dropped {
            notes.push(format!(
                "{k} in the project's object or part settings is not used (custom G-code and scripts come from the printer settings)"
            ));
        }
        // the object's own settings travel with its mesh, for a slice of it alone (`with_lone_settings`)
        let settings = if object.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::Object(object)
        };
        let own = if o.name.is_empty() {
            name.to_owned()
        } else {
            o.name
        };
        plates.entry(o.plate.unwrap_or(1)).or_default().push(Mesh {
            name: own,
            parts,
            volumes,
            part_settings,
            notes,
            settings,
        });
    }
    if plates.is_empty() {
        return Err(Error::mesh(name, "the 3MF file has no printable objects"));
    }
    Ok(plates.into_iter().collect())
}

/// One part placed by the build item's transform and its components, with its paint decoded in place, as
/// [`make_part`] places a mesh object.
#[cfg(feature = "import")]
fn geom_part(p: &sx_geom::format::Part, item: &Transform, slot: u8, name: String) -> MeshPart {
    let positions = p.placed(item, 1.0);
    let decode_all = |list: &[(u32, String)]| -> Vec<crate::paint::PaintFacet> {
        list.iter()
            .filter_map(|(k, code)| {
                let tri = p.triangles.get(*k as usize)?;
                let corners = [
                    *positions.get(tri[0] as usize)?,
                    *positions.get(tri[1] as usize)?,
                    *positions.get(tri[2] as usize)?,
                ];
                Some(crate::paint::decode(code, corners))
            })
            .flatten()
            .collect()
    };
    let paint: Vec<crate::paint::PaintFacet> = decode_all(&p.paint.color)
        .into_iter()
        .filter(|f| f.state != slot)
        .collect();
    let seam_paint = decode_all(&p.paint.seam);
    let fuzzy_paint = decode_all(&p.paint.fuzzy);
    let support_paint = decode_all(&p.paint.support);
    let mut paint_texts = Vec::new();
    for (layer, list) in [
        (0u8, &p.paint.color),
        (1, &p.paint.seam),
        (2, &p.paint.support),
        (3, &p.paint.fuzzy),
    ] {
        for (k, code) in list {
            paint_texts.push((layer, *k, code.clone()));
        }
    }
    // decoded paint is collected through a flatten, which leaves room it never uses; a big painted part keeps none
    let mut paint = paint;
    let (mut seam_paint, mut fuzzy_paint, mut support_paint) = (seam_paint, fuzzy_paint, support_paint);
    for v in [&mut paint, &mut seam_paint, &mut fuzzy_paint, &mut support_paint] {
        v.shrink_to_fit();
    }
    paint_texts.shrink_to_fit();
    MeshPart {
        name,
        slot,
        color: None,
        positions,
        triangles: p.triangles.clone(),
        paint,
        support_paint,
        seam_paint,
        fuzzy_paint,
        paint_texts,
    }
}

/// Object names from Bambu and Orca project metadata (`<object id>` with a `name` entry).
fn object_names(xml: &[u8]) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let mut object: Option<u32> = None;
    let mut part = false;
    for t in tags(xml) {
        match (t.name, t.closing) {
            ("object", false) => object = t.attr("id").and_then(|v| v.parse().ok()),
            ("object", true) => object = None,
            ("part", c) => part = !c,
            ("metadata", false) if !part && t.attr("key") == Some("name") => {
                if let (Some(o), Some(v)) = (object, t.attr("value")) {
                    map.entry(o).or_insert_with(|| v.to_owned());
                }
            }
            _ => {}
        }
    }
    map
}

/// The settings a Bambu Studio or Orca project carries next to its geometry.
/// The field names match the request of `sx-settings`' `import_project_json`.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    /// `Metadata/project_settings.config`, parsed (a JSON object of Orca keys).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_settings: Option<serde_json::Value>,
    /// Text of `Metadata/model_settings.config` (per-object settings, plates).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_settings: Option<String>,
    /// Text of `Metadata/layer_config_ranges.xml` (per-height overrides).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer_ranges: Option<String>,
    /// Keys removed from `project_settings` because a file may not carry them
    /// (`post_process` runs programs, host passwords and API keys are secrets).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dropped_keys: Vec<String>,
    /// Painted brim ears (`Metadata/brim_ear_points.txt`) per object, 1-based in the file's order: x, y, z in
    /// the space the mesh loads in (the build transform applied), and the radius of the ear head, mm.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub brim_ear_points: Vec<BrimEars>,
}

/// The painted brim ears of one object of a project.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct BrimEars {
    pub object: u32,
    pub points: Vec<[f32; 4]>,
}

/// Parses `brim_ear_points.txt`: an optional `brim_points_format_version=` line, then one
/// `object_id=N|x y z r x y z r ...` line per object.
fn parse_brim_ears(text: &str) -> Vec<(u32, Vec<[f32; 4]>)> {
    text.lines()
        .filter_map(|line| {
            let (head, body) = line.split_once('|')?;
            let id: u32 = head.strip_prefix("object_id=")?.trim().parse().ok()?;
            let nums: Vec<f32> = body
                .split_ascii_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect();
            let points: Vec<[f32; 4]> = nums.as_chunks::<4>().0.to_vec();
            (id > 0 && !points.is_empty()).then_some((id, points))
        })
        .collect()
}

/// The app that wrote a 3MF (its main model's `Application` metadata, such as `BambuStudio-01.10.02.73`).
pub(crate) fn application(bytes: &[u8]) -> Option<String> {
    let zip = Zip::open(bytes).ok()?;
    let model = zip.read("3D/3dmodel.model").ok()?;
    let text = std::str::from_utf8(model.get(..model.len().min(64 * 1024))?).ok()?;
    let at = text.find("name=\"Application\"")?;
    let rest = text.get(at..)?;
    let start = rest.find('>')? + 1;
    let end = rest.get(start..)?.find('<')?;
    Some(rest.get(start..start + end)?.trim().to_owned()).filter(|a| !a.is_empty())
}

/// Reads the settings entries of a 3MF project without touching the geometry.
/// Entries the file does not have are `None`; a plain 3MF returns all `None`.
/// Fails when the bytes are not a ZIP archive or `project_settings.config` is
/// not JSON.
pub fn metadata(bytes: &[u8], name: &str) -> Result<ProjectMetadata> {
    let zip = Zip::open(bytes).map_err(|e| Error::mesh(name, e))?;
    let text = |entry: &str| {
        zip.read(entry)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    let project_settings = zip
        .read("Metadata/project_settings.config")
        .ok()
        .map(|b| {
            serde_json::from_slice(&b)
                .map_err(|e| Error::mesh(name, format!("project_settings.config is not JSON: {e}")))
        })
        .transpose()?;
    let mut project_settings: Option<serde_json::Value> = project_settings;
    let mut dropped_keys = Vec::new();
    if let Some(serde_json::Value::Object(map)) = project_settings.as_mut() {
        map.retain(|k, _| {
            let keep = !crate::preflight::is_never_imported(k);
            if !keep {
                dropped_keys.push(k.clone());
            }
            keep
        });
    }
    // The ears sit in object space; the build item's transform puts them where the geometry loads.
    let brim_ear_points = text("Metadata/brim_ear_points.txt")
        .map(|t| parse_brim_ears(&t))
        .filter(|v| !v.is_empty())
        .map(|ears| {
            let root = zip
                .read("_rels/.rels")
                .ok()
                .and_then(|rels| {
                    tags(&rels)
                        .filter(|t| t.name == "Relationship")
                        .find(|t| t.attr("Type").is_some_and(|ty| ty.ends_with("/3dmodel")))
                        .and_then(|t| t.attr("Target").map(|s| s.trim_start_matches('/').to_owned()))
                })
                .unwrap_or_else(|| "3D/3dmodel.model".to_owned());
            let main = zip
                .read(&root)
                .ok()
                .and_then(|b| parse_model(&b).ok())
                .unwrap_or_default();
            ears.into_iter()
                .map(|(object, pts)| {
                    let item = usize::try_from(object - 1).ok().and_then(|i| main.build.get(i));
                    let t = item.map_or(IDENTITY, |i| i.transform);
                    let scale = if main.unit_scale > 0.0 {
                        main.unit_scale
                    } else {
                        1.0
                    };
                    BrimEars {
                        object,
                        points: pts
                            .into_iter()
                            .map(|p| {
                                let q = apply(&t, [p[0], p[1], p[2]]);
                                [q[0] * scale, q[1] * scale, q[2] * scale, p[3]]
                            })
                            .collect(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ProjectMetadata {
        project_settings,
        model_settings: text("Metadata/model_settings.config"),
        layer_ranges: text("Metadata/layer_config_ranges.xml"),
        dropped_keys,
        brim_ear_points,
    })
}

/// Plate number per build object from Bambu and Orca project metadata
/// (`<plate>` with `plater_id` and `model_instance` / `object_id`).
fn plate_map(xml: &[u8]) -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    let mut plate: Option<u32> = None;
    let mut in_instance = false;
    for t in tags(xml) {
        match (t.name, t.closing) {
            ("plate", _) => plate = None,
            ("model_instance", c) => in_instance = !c,
            ("metadata", false) => {
                let value = t.attr("value").and_then(|v| v.parse::<u32>().ok());
                match (t.attr("key"), in_instance) {
                    (Some("plater_id"), false) => plate = value,
                    (Some("object_id"), true) => {
                        if let (Some(p), Some(o)) = (plate, value) {
                            map.entry(o).or_insert(p);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    map
}

/// 3MF transform: rows of a 4x3 matrix applied to row vectors.
type Transform = [f32; 12];

const IDENTITY: Transform = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0];

/// A `transform` attribute: twelve finite numbers, or none at all (the identity). Anything else is refused as
/// `transform` for object `owner` (0 for a build item) and element `at`, not read as the identity.
fn parse_transform(s: Option<&str>, owner: u32, at: usize) -> Parsed<Transform> {
    let Some(s) = s else { return Ok(IDENTITY) };
    let v: Vec<f32> = s
        .split_ascii_whitespace()
        .filter_map(|x| x.parse::<f32>().ok().filter(|f| f.is_finite()))
        .collect();
    match v.as_slice().try_into() {
        Ok(t) if s.split_ascii_whitespace().count() == 12 => Ok(t),
        _ => Err(Refused("transform", owner, at, s.to_owned())),
    }
}

/// Why a model file is refused: a code, the object (0 for the file itself), the element's place in it and the
/// value read. The engine keeps it this short; the app words it (`engine-errors.ts` in the app package):
/// `unit`, `extension`, `id`, `vertex`, `triangle` (not a vertex number), `index` (past the object's vertex count,
/// which is the value) and `transform`.
struct Refused(&'static str, u32, usize, String);

type Parsed<T> = std::result::Result<T, Refused>;

/// `<path>: refused <code> <object> <element> <value>`, the text the app reads.
fn refused(path: &str, r: Refused) -> String {
    let Refused(code, object, at, value) = r;
    [
        path,
        ": refused ",
        code,
        " ",
        &object.to_string(),
        " ",
        &at.to_string(),
        " ",
        &value,
    ]
    .concat()
}

/// 3MF extensions whose content this loader reads or may leave out without changing the geometry: production
/// (components in other model files), materials and properties (colors), and the slicers' own namespaces.
const READ_EXTENSIONS: &[&str] = &[
    "http://schemas.microsoft.com/3dmanufacturing/production/2015/06",
    "http://schemas.microsoft.com/3dmanufacturing/material/2015/02",
    "http://schemas.bambulab.com/package/2021",
    "http://schemas.slic3r.org/3mf/2017/06",
];

/// `a` then `b`.
fn compose(a: &Transform, b: &Transform) -> Transform {
    let m = |t: &Transform, r: usize, c: usize| t.get(r * 3 + c).copied().unwrap_or(0.0);
    let mut out = [0f32; 12];
    for r in 0..4 {
        for c in 0..3 {
            let mut acc = if r == 3 { m(b, 3, c) } else { 0.0 };
            for k in 0..3 {
                acc += m(a, r, k) * m(b, k, c);
            }
            if let Some(o) = out.get_mut(r * 3 + c) {
                *o = acc;
            }
        }
    }
    out
}

fn apply(t: &Transform, p: [f32; 3]) -> [f32; 3] {
    let [a, b, c, d, e, f, g, h, i, j, k, l] = *t;
    let [x, y, z] = p;
    [
        x * a + y * d + z * g + j,
        x * b + y * e + z * h + k,
        x * c + y * f + z * i + l,
    ]
}

#[derive(Debug, Default)]
struct Object {
    positions: Vec<[f32; 3]>,
    triangles: Vec<[u32; 3]>,
    /// `(triangle index, paint text)` of the painted triangles.
    paint: Vec<(usize, String)>,
    /// The same for painted supports (`paint_supports`).
    support_paint: Vec<(usize, String)>,
    /// The same for painted seams (`paint_seam`).
    seam_paint: Vec<(usize, String)>,
    /// The same for painted fuzzy skin (`paint_fuzzy_skin`).
    fuzzy_paint: Vec<(usize, String)>,
    /// `(object id, model path, transform)`; an empty path means this model.
    components: Vec<(u32, String, Transform)>,
    name: String,
}

#[derive(Debug, Default)]
struct Model {
    objects: HashMap<u32, Object>,
    build: Vec<BuildItem>,
    unit_scale: f32,
}

#[derive(Debug, Clone, Copy)]
struct BuildItem {
    object: u32,
    transform: Transform,
}

/// One model file. Refuses, with what and where, what the loader would otherwise have to guess: an unknown unit,
/// an extension the file requires that is not read here, a vertex coordinate or transform that is not a number,
/// a triangle whose corner is not one of its object's vertices, an object or item without a usable id.
fn parse_model(xml: &[u8]) -> Parsed<Model> {
    let mut model = Model {
        unit_scale: 1.0,
        ..Model::default()
    };
    let mut current: Option<(u32, Object)> = None;
    let id_of = |t: &Tag<'_>, key: &str, owner: u32| -> Parsed<u32> {
        let v = t.attr(key).unwrap_or("");
        v.trim()
            .parse()
            .map_err(|_| Refused("id", owner, 0, v.to_owned()))
    };
    for t in tags(xml) {
        match (t.name, t.closing) {
            ("model", false) => {
                model.unit_scale = match t.attr("unit").unwrap_or("millimeter") {
                    "micron" => 0.001,
                    "millimeter" => 1.0,
                    "centimeter" => 10.0,
                    "inch" => 25.4,
                    "foot" => 304.8,
                    "meter" => 1000.0,
                    other => return Err(Refused("unit", 0, 0, other.to_owned())),
                };
                for prefix in t
                    .attr("requiredextensions")
                    .unwrap_or("")
                    .split_ascii_whitespace()
                {
                    let ns = t.attr(&["xmlns:", prefix].concat()).unwrap_or(prefix);
                    if !READ_EXTENSIONS.contains(&ns) {
                        return Err(Refused("extension", 0, 0, ns.to_owned()));
                    }
                }
            }
            ("object", false) => {
                let id = id_of(&t, "id", 0)?;
                let name = t.attr("name").unwrap_or("").to_owned();
                current = Some((
                    id,
                    Object {
                        name,
                        ..Object::default()
                    },
                ));
            }
            ("object", true) => {
                if let Some((id, o)) = current.take() {
                    let n = o.positions.len();
                    if let Some(k) = o
                        .triangles
                        .iter()
                        .position(|tri| tri.iter().any(|&i| i as usize >= n))
                    {
                        return Err(Refused("index", id, k, n.to_string()));
                    }
                    model.objects.insert(id, o);
                }
            }
            ("vertex", false) => {
                if let Some((id, o)) = current.as_mut() {
                    let k = o.positions.len();
                    let f = |c: &str| {
                        let v = t.attr(c).unwrap_or("");
                        v.trim()
                            .parse::<f32>()
                            .ok()
                            .filter(|f| f.is_finite())
                            .ok_or_else(|| Refused("vertex", *id, k, v.to_owned()))
                    };
                    o.positions.push([f("x")?, f("y")?, f("z")?]);
                }
            }
            ("triangle", false) => {
                if let Some((id, o)) = current.as_mut() {
                    let k = o.triangles.len();
                    let f = |c: &str| {
                        let v = t.attr(c).unwrap_or("");
                        v.trim()
                            .parse::<u32>()
                            .map_err(|_| Refused("triangle", *id, k, v.to_owned()))
                    };
                    let (a, b, c) = (f("v1")?, f("v2")?, f("v3")?);
                    if let Some(code) = t
                        .attr("paint_color")
                        .or_else(|| t.attr("slic3rpe:mmu_segmentation"))
                        .filter(|c| !c.is_empty())
                    {
                        o.paint.push((o.triangles.len(), code.to_owned()));
                    }
                    if let Some(code) = t
                        .attr("paint_supports")
                        .or_else(|| t.attr("slic3rpe:custom_supports"))
                        .filter(|c| !c.is_empty())
                    {
                        o.support_paint.push((o.triangles.len(), code.to_owned()));
                    }
                    if let Some(code) = t
                        .attr("paint_seam")
                        .or_else(|| t.attr("slic3rpe:custom_seam"))
                        .filter(|c| !c.is_empty())
                    {
                        o.seam_paint.push((o.triangles.len(), code.to_owned()));
                    }
                    if let Some(code) = t.attr("paint_fuzzy_skin").filter(|c| !c.is_empty()) {
                        o.fuzzy_paint.push((o.triangles.len(), code.to_owned()));
                    }
                    o.triangles.push([a, b, c]);
                }
            }
            ("component", false) => {
                if let Some((owner, o)) = current.as_mut() {
                    let id = id_of(&t, "objectid", *owner)?;
                    let path = t.attr("p:path").unwrap_or("").trim_start_matches('/').to_owned();
                    let transform = parse_transform(t.attr("transform"), *owner, o.components.len())?;
                    o.components.push((id, path, transform));
                }
            }
            ("item", false) => {
                let object = id_of(&t, "objectid", 0)?;
                let printable = t.attr("printable").is_none_or(|v| v != "0");
                if printable {
                    model.build.push(BuildItem {
                        object,
                        transform: parse_transform(t.attr("transform"), 0, model.build.len())?,
                    });
                }
            }
            _ => {}
        }
    }
    Ok(model)
}

/// Filament slot per object or part id from Bambu and Orca project metadata.
fn slot_map(xml: &[u8]) -> HashMap<u32, u8> {
    let mut map = HashMap::new();
    let mut object: Option<u32> = None;
    let mut part: Option<u32> = None;
    for t in tags(xml) {
        match (t.name, t.closing) {
            ("object", false) => object = t.attr("id").and_then(|v| v.parse().ok()),
            ("object", true) => object = None,
            ("part", false) => part = t.attr("id").and_then(|v| v.parse().ok()),
            ("part", true) => part = None,
            ("metadata", false) if t.attr("key") == Some("extruder") => {
                if let Some(slot) = t.attr("value").and_then(|v| v.parse::<u8>().ok()) {
                    match (part, object) {
                        (Some(p), _) => {
                            map.insert(p, slot);
                        }
                        (None, Some(o)) => {
                            map.entry(o).or_insert(slot);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    map
}

struct Resolve<'a> {
    zip: &'a Zip<'a>,
    models: &'a mut HashMap<String, Model>,
    parts: &'a mut Vec<MeshPart>,
    /// The item's parts that do not print (cuts, modifiers, support volumes).
    volumes: &'a mut Vec<MeshVolume>,
    /// `(index in parts, part id, settings)` of the printed parts the project gives settings.
    with_settings: &'a mut Vec<(usize, u32, serde_json::Value)>,
    notes: &'a mut Vec<String>,
    meta: &'a ProjectParts,
    slots: &'a HashMap<u32, u8>,
    name: &'a str,
    /// What is left of [`MAX_WORK`] for the whole file, charged per build item before it is placed.
    work: &'a mut u64,
}

impl Resolve<'_> {
    /// The work placing object `id` asks for: one unit per object visited plus its vertices and triangles,
    /// summed over every copy its components place. Each object is costed once, so this is quick however
    /// many copies the file asks for.
    fn cost(
        &mut self,
        model: &Model,
        path: &str,
        id: u32,
        depth: u32,
        memo: &mut HashMap<(String, u32), u64>,
    ) -> Result<u64> {
        if depth > MAX_DEPTH {
            return Err(Error::mesh(self.name, "3MF components nest too deep"));
        }
        if let Some(&c) = memo.get(&(path.to_owned(), id)) {
            return Ok(c);
        }
        let Some(obj) = model.objects.get(&id) else {
            return Err(Error::mesh(
                self.name,
                format!("3MF object {id} is missing in {path}"),
            ));
        };
        let mut total = 1 + (obj.positions.len() + obj.triangles.len()) as u64;
        for (child, child_path, _) in &obj.components {
            let c = if child_path.is_empty() || child_path == path {
                self.cost(model, path, *child, depth + 1, memo)?
            } else {
                if !self.models.contains_key(child_path) {
                    let bytes = self.zip.read(child_path).map_err(|e| Error::mesh(self.name, e))?;
                    let m =
                        parse_model(&bytes).map_err(|e| Error::mesh(self.name, refused(child_path, e)))?;
                    self.models.insert(child_path.clone(), m);
                }
                let sub = self.models.remove(child_path).unwrap_or_default();
                let r = self.cost(&sub, child_path, *child, depth + 1, memo);
                self.models.insert(child_path.clone(), sub);
                r?
            };
            total = total.saturating_add(c);
        }
        memo.insert((path.to_owned(), id), total);
        Ok(total)
    }

    fn object(
        &mut self,
        model: &Model,
        path: &str,
        id: u32,
        t: Transform,
        top: u32,
        depth: u32,
    ) -> Result<()> {
        if depth > MAX_DEPTH {
            return Err(Error::mesh(self.name, "3MF components nest too deep"));
        }
        let Some(obj) = model.objects.get(&id) else {
            return Err(Error::mesh(
                self.name,
                format!("3MF object {id} is missing in {path}"),
            ));
        };
        if !obj.triangles.is_empty() {
            let slot = self
                .slots
                .get(&id)
                .or_else(|| self.slots.get(&top))
                .copied()
                .unwrap_or(1)
                .max(1);
            let name = if obj.name.is_empty() {
                format!("part {}", self.parts.len() + self.volumes.len() + 1)
            } else {
                obj.name.clone()
            };
            // The project's part list lives as long as the file; read it apart from `self`, which `place` changes.
            let meta = self.meta;
            // An older project keeps every part of an object in one mesh, each a range of its triangles.
            if let Some(ranges) = meta.range_parts(id) {
                for info in ranges {
                    let Some((first, last)) = info.range else {
                        continue;
                    };
                    let sub = obj.triangle_range(first, last);
                    if sub.triangles.is_empty() {
                        continue;
                    }
                    let part_slot = info.slot.unwrap_or(slot).max(1);
                    let part_name = info.name.clone().unwrap_or_else(|| name.clone());
                    let part = make_part(&sub, &t, part_slot, part_name);
                    self.place(part, info, top, id);
                }
            } else {
                let part = make_part(obj, &t, slot, name);
                let info = meta.part(top, id).cloned().unwrap_or_default();
                self.place(part, &info, top, id);
            }
        }
        for (child, child_path, ct) in &obj.components {
            let t2 = compose(ct, &t);
            if child_path.is_empty() || child_path == path {
                self.object(model, path, *child, t2, top, depth + 1)?;
            } else {
                if !self.models.contains_key(child_path) {
                    let bytes = self.zip.read(child_path).map_err(|e| Error::mesh(self.name, e))?;
                    let m =
                        parse_model(&bytes).map_err(|e| Error::mesh(self.name, refused(child_path, e)))?;
                    self.models.insert(child_path.clone(), m);
                }
                let sub = self.models.remove(child_path).unwrap_or_default();
                let r = self.object(&sub, child_path, *child, t2, top, depth + 1);
                self.models.insert(child_path.clone(), sub);
                r?;
            }
        }
        Ok(())
    }

    /// Puts a loaded part where its type says: printed parts with their settings, the rest as volumes.
    fn place(&mut self, part: MeshPart, info: &PartInfo, top: u32, id: u32) {
        let shown = info.name.clone().unwrap_or_else(|| part.name.clone());
        if let Some(other) = &info.unknown_type {
            self.notes.push(format!(
                "{shown}: part type {other} is not one this engine knows; it prints as a normal part"
            ));
        }
        let meta = self.meta;
        let object = meta.object(top);
        // Keys the engine does not read are named once each, as a request's own object settings are.
        let unread: Vec<&String> = object
            .into_iter()
            .flat_map(|o| o.keys())
            .chain(info.settings.keys())
            .filter(|k| {
                !crate::config::READ_KEYS.contains(&k.as_str())
                    && !crate::config::FUZZY_KEYS.contains(&k.as_str())
            })
            .collect();
        for k in unread {
            let line = format!("{k} is not applied by this engine (project part or object setting)");
            if !self.notes.contains(&line) {
                self.notes.push(line);
            }
        }
        match info.role {
            None => {
                // The object's settings, then the part's own on top.
                let mut settings = object.cloned().unwrap_or_default();
                settings.extend(info.settings.iter().map(|(k, v)| (k.clone(), v.clone())));
                if !settings.is_empty() {
                    self.with_settings
                        .push((self.parts.len(), id, serde_json::Value::Object(settings)));
                }
                self.parts.push(part);
            }
            Some(role) => {
                let settings = if role == VolumeRole::Modifier {
                    // A modifier's region keeps the object's settings under the modifier's own.
                    let mut s = object.cloned().unwrap_or_default();
                    s.extend(info.settings.iter().map(|(k, v)| (k.clone(), v.clone())));
                    serde_json::Value::Object(s)
                } else {
                    if !info.settings.is_empty() {
                        self.notes.push(format!(
                            "{shown}: settings on a {} are not used ({})",
                            role_name(role),
                            info.settings.keys().cloned().collect::<Vec<_>>().join(", ")
                        ));
                    }
                    serde_json::Value::Null
                };
                self.volumes.push(MeshVolume {
                    role,
                    part: MeshPart { name: shown, ..part },
                    settings,
                });
            }
        }
    }
}

/// One mesh object as a part placed by `t`, with its paint decoded in place.
fn make_part(obj: &Object, t: &Transform, slot: u8, name: String) -> MeshPart {
    let positions: Vec<[f32; 3]> = obj.positions.iter().map(|p| apply(t, *p)).collect();
    let n = obj.positions.len();
    let decode_all = |list: &[(usize, String)]| -> Vec<crate::paint::PaintFacet> {
        list.iter()
            .filter_map(|(k, code)| {
                let tri = obj.triangles.get(*k)?;
                let corners = [
                    *positions.get(tri[0] as usize)?,
                    *positions.get(tri[1] as usize)?,
                    *positions.get(tri[2] as usize)?,
                ];
                Some(crate::paint::decode(code, corners))
            })
            .flatten()
            .collect()
    };
    // Painted pieces in place (the part's own paint is skipped when it is the part's filament).
    let paint: Vec<crate::paint::PaintFacet> = decode_all(&obj.paint)
        .into_iter()
        .filter(|f| f.state != slot)
        .collect();
    let seam_paint = decode_all(&obj.seam_paint);
    let fuzzy_paint = decode_all(&obj.fuzzy_paint);
    let support_paint = decode_all(&obj.support_paint);
    let triangles: Vec<[u32; 3]> = obj
        .triangles
        .iter()
        .filter(|tri| tri.iter().all(|&i| (i as usize) < n))
        .copied()
        .collect();
    // The texts by the index each painted triangle keeps once triangles outside the vertices are dropped.
    let mut kept = Vec::with_capacity(obj.triangles.len());
    let mut next = 0u32;
    for tri in &obj.triangles {
        kept.push(tri.iter().all(|&i| (i as usize) < n).then_some(next));
        next += u32::from(kept.last().copied().flatten().is_some());
    }
    let mut paint_texts = Vec::new();
    for (layer, list) in [
        (0u8, &obj.paint),
        (1, &obj.seam_paint),
        (2, &obj.support_paint),
        (3, &obj.fuzzy_paint),
    ] {
        for (k, code) in list {
            if let Some(Some(t)) = kept.get(*k) {
                paint_texts.push((layer, *t, code.clone()));
            }
        }
    }
    let mut part = MeshPart {
        name,
        slot,
        color: None,
        positions,
        triangles,
        paint,
        support_paint,
        seam_paint,
        fuzzy_paint,
        paint_texts,
    };
    part.shrink_to_fit();
    part
}

impl Object {
    /// Triangles `first..=last` of this object as an object of their own (an older project's part), with the
    /// paint of those triangles.
    fn triangle_range(&self, first: u32, last: u32) -> Self {
        let (first, last) = (first as usize, last as usize);
        let take = |list: &[(usize, String)]| -> Vec<(usize, String)> {
            list.iter()
                .filter(|(k, _)| (first..=last).contains(k))
                .map(|(k, s)| (k - first, s.clone()))
                .collect()
        };
        // Only the vertices these triangles use, so the part's size is its own.
        let picked = self
            .triangles
            .get(first..=last.min(self.triangles.len().saturating_sub(1)))
            .unwrap_or_default();
        let mut index: HashMap<u32, u32> = HashMap::new();
        let mut positions = Vec::new();
        let mut triangles = Vec::with_capacity(picked.len());
        for tri in picked {
            let mut out = [0u32; 3];
            for (o, &i) in out.iter_mut().zip(tri) {
                *o = *index.entry(i).or_insert_with(|| {
                    positions.push(self.positions.get(i as usize).copied().unwrap_or_default());
                    u32::try_from(positions.len() - 1).unwrap_or(u32::MAX)
                });
            }
            triangles.push(out);
        }
        Self {
            positions,
            triangles,
            paint: take(&self.paint),
            support_paint: take(&self.support_paint),
            seam_paint: take(&self.seam_paint),
            fuzzy_paint: take(&self.fuzzy_paint),
            components: Vec::new(),
            name: self.name.clone(),
        }
    }
}

/// What a project's `Metadata/model_settings.config` says about one part.
#[derive(Debug, Clone, Default)]
struct PartInfo {
    /// `None` for a part that prints.
    role: Option<VolumeRole>,
    /// The type text when it is not one of the known ones (the part then prints).
    unknown_type: Option<String>,
    name: Option<String>,
    /// The part's own setting overrides.
    settings: serde_json::Map<String, serde_json::Value>,
    /// An older project's part: triangles `first..=last` of its object's mesh, and its filament.
    range: Option<(u32, u32)>,
    slot: Option<u8>,
}

/// The parts, part ranges and object settings of a project.
#[derive(Debug, Default)]
struct ProjectParts {
    /// `(object id, part id, part)`: the build object and the mesh object a component places. A project has tens
    /// of parts, so lists do (and keep the engine's WebAssembly build small).
    parts: Vec<(u32, u32, PartInfo)>,
    /// Older projects: per object id, the parts as triangle ranges of the object's own mesh, in file order.
    ranges: Vec<(u32, Vec<PartInfo>)>,
    /// Each object's own setting overrides.
    objects: Vec<(u32, serde_json::Map<String, serde_json::Value>)>,
    /// Setting keys left out of object and part settings: custom G-code and keys a file may never set.
    dropped: Vec<String>,
}

impl ProjectParts {
    /// An older project's parts of object `id`, as triangle ranges of its mesh.
    fn range_parts(&self, id: u32) -> Option<&Vec<PartInfo>> {
        self.ranges
            .iter()
            .find(|(k, l)| *k == id && !l.is_empty())
            .map(|(_, l)| l)
    }

    fn part(&self, object: u32, id: u32) -> Option<&PartInfo> {
        self.parts
            .iter()
            .find(|(o, p, _)| (*o, *p) == (object, id))
            .map(|(_, _, info)| info)
    }

    fn object(&self, id: u32) -> Option<&serde_json::Map<String, serde_json::Value>> {
        self.objects.iter().find(|(k, _)| *k == id).map(|(_, m)| m)
    }
}

/// Part metadata that describes the part rather than setting how it prints.
const PART_KEYS: &[&str] = &[
    "name",
    "matrix",
    "mesh_shared",
    "extruder",
    "volume_type",
    "part_type",
    "source_file",
    "source_object_id",
    "source_volume_id",
    "source_offset_x",
    "source_offset_y",
    "source_offset_z",
    "source_in_inches",
    "source_in_meters",
];

/// Object metadata that describes the object rather than setting how it prints.
const OBJECT_KEYS: &[&str] = &["name", "extruder", "module"];

/// The type a part's `subtype` text names: `None` prints, `Err` is a text this engine does not know.
fn part_role(text: &str) -> std::result::Result<Option<VolumeRole>, ()> {
    match text {
        "" | "normal_part" => Ok(None),
        "negative_part" => Ok(Some(VolumeRole::Negative)),
        "modifier_part" => Ok(Some(VolumeRole::Modifier)),
        "support_blocker" => Ok(Some(VolumeRole::SupportBlocker)),
        "support_enforcer" => Ok(Some(VolumeRole::SupportEnforcer)),
        _ => Err(()),
    }
}

/// A role as people read it, for warnings.
fn role_name(role: VolumeRole) -> &'static str {
    match role {
        VolumeRole::Negative => "negative part",
        VolumeRole::Modifier => "modifier",
        VolumeRole::SupportBlocker => "support blocker",
        VolumeRole::SupportEnforcer => "support enforcer",
    }
}

impl PartInfo {
    fn set_type(&mut self, text: &str) {
        if let Ok(role) = part_role(text) {
            self.role = role;
            self.unknown_type = None;
        } else {
            self.role = None;
            self.unknown_type = Some(text.to_owned());
        }
    }
}

/// Reads part types, part settings and object settings from Bambu Studio and `OrcaSlicer` project metadata:
/// `<object id>` with `<metadata>` and `<part id subtype>` (or an older project's `<volume firstid lastid>`)
/// entries. A part type given as `volume_type` or `part_type` metadata replaces the `subtype` attribute.
fn project_parts(xml: &[u8]) -> ProjectParts {
    let mut out = ProjectParts::default();
    let mut object: Option<u32> = None;
    // The part being read: its id (for `<part>`) and what is known so far.
    let mut part: Option<(Option<u32>, PartInfo)> = None;
    for t in tags(xml) {
        match (t.name, t.closing) {
            ("object", false) => object = t.attr("id").and_then(|v| v.trim().parse().ok()),
            ("object", true) => object = None,
            ("part" | "volume", false) if object.is_some() => {
                let mut info = PartInfo::default();
                info.set_type(t.attr("subtype").unwrap_or(""));
                let last = t.attr("lastid").and_then(|v| v.trim().parse::<u32>().ok());
                let first = t.attr("firstid").and_then(|v| v.trim().parse::<u32>().ok());
                let id = t.attr("id").and_then(|v| v.trim().parse::<u32>().ok());
                if t.name == "volume"
                    && let (Some(f), Some(l)) = (first, last)
                    && l > 0
                {
                    info.range = Some((f, l));
                }
                part = Some((id, info));
            }
            ("part" | "volume", true) => finish_part(&mut out, object, part.take()),
            ("metadata", false) => {
                let (Some(k), Some(v)) = (t.attr("key"), t.attr("value")) else {
                    continue;
                };
                let v = unescape(v);
                // A file's object and part settings never carry custom G-code or scripts and secrets: those go
                // through the printer's own checks, which per-object settings would get round.
                if (part.is_some() || object.is_some())
                    && !PART_KEYS.contains(&k)
                    && !OBJECT_KEYS.contains(&k)
                    && (k.contains("gcode") || crate::preflight::is_never_imported(k))
                {
                    if !out.dropped.iter().any(|d| d == k) {
                        out.dropped.push(k.to_owned());
                    }
                    continue;
                }
                match (&mut part, object) {
                    (Some((_, info)), _) => match k {
                        "name" => info.name = Some(v),
                        "volume_type" | "part_type" => info.set_type(&v),
                        "extruder" => info.slot = v.trim().parse().ok(),
                        k if PART_KEYS.contains(&k) => {}
                        k => {
                            info.settings.insert(k.to_owned(), serde_json::Value::String(v));
                        }
                    },
                    (None, Some(o)) if !OBJECT_KEYS.contains(&k) => {
                        let at = out.objects.iter().position(|(k, _)| *k == o).unwrap_or_else(|| {
                            out.objects.push((o, serde_json::Map::new()));
                            out.objects.len() - 1
                        });
                        if let Some((_, map)) = out.objects.get_mut(at) {
                            map.insert(k.to_owned(), serde_json::Value::String(v));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

fn finish_part(out: &mut ProjectParts, object: Option<u32>, part: Option<(Option<u32>, PartInfo)>) {
    let (Some(o), Some((id, info))) = (object, part) else {
        return;
    };
    if info.range.is_some() {
        match out.ranges.iter_mut().find(|(k, _)| *k == o) {
            Some((_, list)) => list.push(info),
            None => out.ranges.push((o, vec![info])),
        }
    } else if let Some(id) = id {
        out.parts.retain(|(a, b, _)| (*a, *b) != (o, id));
        out.parts.push((o, id, info));
    }
}

/// XML's five named entities and numeric references, as metadata values may carry them.
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(end) = tail.find(';') else {
            out.push_str(tail);
            return out;
        };
        let ent = &tail[1..end];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => out.push(c),
            None => out.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

/// One XML tag: name, attributes and whether it closes an element.
struct Tag<'a> {
    name: &'a str,
    attrs: &'a str,
    closing: bool,
}

impl<'a> Tag<'a> {
    fn attr(&self, key: &str) -> Option<&'a str> {
        let mut rest = self.attrs;
        loop {
            let eq = rest.find('=')?;
            let k = rest.get(..eq)?.trim();
            let after = rest.get(eq + 1..)?.trim_start();
            let quote = after.chars().next()?;
            if quote != '"' && quote != '\'' {
                return None;
            }
            let body = after.get(1..)?;
            let end = body.find(quote)?;
            if k == key {
                return body.get(..end);
            }
            rest = body.get(end + 1..)?;
        }
    }
}

/// Tags in document order. A self-closing tag is reported as an opening
/// tag followed by a closing one. Comments, declarations and text are skipped;
/// entities in attribute values are left as they are (3MF numbers and ids do
/// not use them).
fn tags(xml: &[u8]) -> impl Iterator<Item = Tag<'_>> {
    let text = std::str::from_utf8(xml).unwrap_or("");
    let mut pos = 0usize;
    let mut pending_close: Option<&str> = None;
    std::iter::from_fn(move || {
        if let Some(name) = pending_close.take() {
            return Some(Tag {
                name,
                attrs: "",
                closing: true,
            });
        }
        loop {
            let rest = text.get(pos..)?;
            let start = rest.find('<')?;
            let body = rest.get(start + 1..)?;
            let end = body.find('>')?;
            pos += start + 1 + end + 1;
            let inner = body.get(..end)?;
            if inner.starts_with('?') || inner.starts_with('!') {
                continue;
            }
            let (closing, inner) = match inner.strip_prefix('/') {
                Some(r) => (true, r),
                None => (false, inner),
            };
            let (inner, self_closing) = match inner.strip_suffix('/') {
                Some(r) => (r, true),
                None => (inner, false),
            };
            let name_end = inner
                .find(|c: char| c.is_ascii_whitespace())
                .unwrap_or(inner.len());
            let full = inner.get(..name_end)?;
            // Drop a namespace prefix (`m:vertex`), keeping `p:path` style attributes intact.
            let name = full.rsplit(':').next().unwrap_or(full);
            let attrs = inner.get(name_end..).unwrap_or("");
            if self_closing {
                pending_close = Some(name);
            }
            return Some(Tag { name, attrs, closing });
        }
    })
}

/// A read-only view of a ZIP archive.
struct Zip<'a> {
    data: &'a [u8],
    entries: Vec<Entry>,
}

struct Entry {
    name: String,
    method: u16,
    compressed: usize,
    size: usize,
    offset: usize,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2)
        .and_then(|s| s.try_into().ok())
        .map(u16::from_le_bytes)
}

fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 8)
        .and_then(|s| s.try_into().ok())
        .map(u64::from_le_bytes)
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .and_then(|s| s.try_into().ok())
        .map(u32::from_le_bytes)
}

impl<'a> Zip<'a> {
    fn open(data: &'a [u8]) -> std::result::Result<Self, String> {
        let bad = || "not a ZIP archive (3MF files are ZIP)".to_owned();
        let min = data.len().checked_sub(22).ok_or_else(bad)?;
        let low = min.saturating_sub(65_535);
        let eocd = (low..=min)
            .rev()
            .find(|&i| u32_at(data, i) == Some(0x0605_4b50))
            .ok_or_else(bad)?;
        let mut count = usize::from(u16_at(data, eocd + 10).ok_or_else(bad)?);
        let mut at = u32_at(data, eocd + 16).ok_or_else(bad)? as usize;
        if at == 0xFFFF_FFFF || count == 0xFFFF {
            // ZIP64: the locator just before the end record points at a
            // 64-bit end record with the real count and offset.
            let loc = eocd.checked_sub(20).ok_or_else(bad)?;
            if u32_at(data, loc) != Some(0x0706_4b50) {
                return Err("broken ZIP64 locator".to_owned());
            }
            let rec = u64_at(data, loc + 8)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(bad)?;
            if u32_at(data, rec) != Some(0x0606_4b50) {
                return Err("broken ZIP64 end record".to_owned());
            }
            count = u64_at(data, rec + 32)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(bad)?;
            at = u64_at(data, rec + 48)
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(bad)?;
        }
        let mut entries = Vec::with_capacity(count.min(1 << 16));
        for _ in 0..count {
            if u32_at(data, at) != Some(0x0201_4b50) {
                return Err("broken ZIP central directory".to_owned());
            }
            let method = u16_at(data, at + 10).ok_or_else(bad)?;
            let mut compressed = u32_at(data, at + 20).ok_or_else(bad)? as usize;
            let mut size = u32_at(data, at + 24).ok_or_else(bad)? as usize;
            let name_len = usize::from(u16_at(data, at + 28).ok_or_else(bad)?);
            let extra_len = usize::from(u16_at(data, at + 30).ok_or_else(bad)?);
            let comment_len = usize::from(u16_at(data, at + 32).ok_or_else(bad)?);
            let mut offset = u32_at(data, at + 42).ok_or_else(bad)? as usize;
            let name =
                String::from_utf8_lossy(data.get(at + 46..at + 46 + name_len).ok_or_else(bad)?).into_owned();
            // ZIP64 extra field: 64-bit values for the fields set to all ones, in this order.
            let extra = data
                .get(at + 46 + name_len..at + 46 + name_len + extra_len)
                .unwrap_or(&[]);
            let mut e = 0;
            while let (Some(id), Some(len)) = (u16_at(extra, e), u16_at(extra, e + 2)) {
                if id == 1 {
                    let body = extra.get(e + 4..e + 4 + usize::from(len)).unwrap_or(&[]);
                    let mut f = 0;
                    for v in [&mut size, &mut compressed, &mut offset] {
                        if *v == 0xFFFF_FFFF
                            && let Some(x) = u64_at(body, f).and_then(|x| usize::try_from(x).ok())
                        {
                            *v = x;
                            f += 8;
                        }
                    }
                }
                e += 4 + usize::from(len);
            }
            entries.push(Entry {
                name,
                method,
                compressed,
                size,
                offset,
            });
            at += 46 + name_len + extra_len + comment_len;
        }
        Ok(Self { data, entries })
    }

    fn read(&self, name: &str) -> std::result::Result<Vec<u8>, String> {
        let e = self
            .entries
            .iter()
            .find(|e| e.name == name || e.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| format!("{name} is missing from the archive"))?;
        if e.size > MAX_ENTRY {
            return Err(format!("{name} is too large"));
        }
        let h = e.offset;
        if u32_at(self.data, h) != Some(0x0403_4b50) {
            return Err(format!("{name}: broken local header"));
        }
        let name_len = usize::from(u16_at(self.data, h + 26).unwrap_or(0));
        let extra_len = usize::from(u16_at(self.data, h + 28).unwrap_or(0));
        let start = h + 30 + name_len + extra_len;
        let raw = self
            .data
            .get(start..start + e.compressed)
            .ok_or_else(|| format!("{name}: truncated"))?;
        match e.method {
            0 => Ok(raw.to_vec()),
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(raw, e.size.max(1))
                .map_err(|err| format!("{name}: deflate error {:?}", err.status)),
            m => Err(format!("{name}: compression method {m} is not supported")),
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "test archives are tiny; coordinates are exact small integers"
)]
mod tests {
    use super::*;

    #[test]
    fn brim_ear_points_parse_per_object() {
        let text = "brim_points_format_version=0\nobject_id=1|1.5 2.5 -0.1 6 3 4 0 5.5\nobject_id=2|bad\n";
        let ears = parse_brim_ears(text);
        assert_eq!(ears.len(), 1);
        assert_eq!(ears[0].0, 1);
        assert_eq!(ears[0].1, vec![[1.5, 2.5, -0.1, 6.0], [3.0, 4.0, 0.0, 5.5]]);
    }

    /// Builds a ZIP with the given entries, stored or deflated.
    fn zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, deflate) in entries {
            let body = if *deflate {
                miniz_oxide::deflate::compress_to_vec(data, 6)
            } else {
                data.to_vec()
            };
            let offset = out.len() as u32;
            let method: u16 = if *deflate { 8 } else { 0 };
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0]);
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 8]);
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&body);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0; 8]);
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_at = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_at.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    /// A box as a 3MF mesh object with id `id`.
    fn box_object(id: u32, lo: [f32; 3], hi: [f32; 3]) -> String {
        use std::fmt::Write as _;
        let v: Vec<[f32; 3]> = (0..8)
            .map(|i| {
                [
                    if i & 1 == 0 { lo[0] } else { hi[0] },
                    if i & 2 == 0 { lo[1] } else { hi[1] },
                    if i & 4 == 0 { lo[2] } else { hi[2] },
                ]
            })
            .collect();
        let tris = [
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ];
        let vs = v.iter().fold(String::new(), |mut acc, p| {
            let _ = write!(acc, r#"<vertex x="{}" y="{}" z="{}"/>"#, p[0], p[1], p[2]);
            acc
        });
        let ts = tris.iter().fold(String::new(), |mut acc, t| {
            let _ = write!(acc, r#"<triangle v1="{}" v2="{}" v3="{}"/>"#, t[0], t[1], t[2]);
            acc
        });
        format!(
            r#"<object id="{id}" type="model"><mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object>"#
        )
    }

    /// A Bambu-layout project: build object 10 made of one component per box (mesh objects 1, 2, ...), and
    /// `settings` as `Metadata/model_settings.config`.
    fn project(boxes: &[([f32; 3], [f32; 3])], settings: &str) -> Vec<u8> {
        use std::fmt::Write as _;
        let objects: String = boxes
            .iter()
            .zip(1u32..)
            .map(|((lo, hi), id)| box_object(id, *lo, *hi))
            .collect();
        let sub = format!(r#"<model unit="millimeter"><resources>{objects}</resources></model>"#);
        let comps = (1..=boxes.len()).fold(String::new(), |mut acc, id| {
            let _ = write!(
                acc,
                r#"<component p:path="/3D/Objects/object_1.model" objectid="{id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>"#
            );
            acc
        });
        let main = format!(
            r#"<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources><object id="10" type="model"><components>{comps}</components></object></resources><build><item objectid="10"/></build></model>"#
        );
        zip(&[
            ("3D/3dmodel.model", main.as_bytes(), true),
            ("3D/Objects/object_1.model", sub.as_bytes(), true),
            ("Metadata/model_settings.config", settings.as_bytes(), false),
        ])
    }

    const BODY: ([f32; 3], [f32; 3]) = ([0.0, 0.0, 0.0], [20.0, 20.0, 10.0]);

    #[test]
    fn part_types_load_as_volumes_and_only_printed_parts_count() {
        let settings = r#"<config><object id="10"><metadata key="name" value="subtypes"/>
<part id="1" subtype="normal_part"><metadata key="name" value="body"/></part>
<part id="2" subtype="negative_part"><metadata key="name" value="notch"/></part>
<part id="3" subtype="modifier_part"><metadata key="name" value="dense"/><metadata key="sparse_infill_density" value="80%"/></part>
<part id="4" subtype="support_blocker"><metadata key="name" value="no support"/></part>
<part id="5" subtype="support_enforcer"/>
</object></config>"#;
        let bytes = project(
            &[
                BODY,
                ([17.0, 17.0, 4.0], [23.0, 23.0, 10.0]),
                ([0.0, 0.0, 0.0], [10.0, 20.0, 30.0]),
                ([30.0, 10.0, 0.0], [36.0, 16.0, 4.0]),
                ([30.0, 20.0, -2.0], [36.0, 26.0, 4.0]),
            ],
            settings,
        );
        let mesh = Mesh::load(&bytes, "subtypes.3mf").unwrap();
        assert_eq!(mesh.parts.len(), 1, "only the normal part prints");
        let roles: Vec<(VolumeRole, &str)> = mesh
            .volumes
            .iter()
            .map(|v| (v.role, v.part.name.as_str()))
            .collect();
        assert_eq!(
            roles,
            [
                (VolumeRole::Negative, "notch"),
                (VolumeRole::Modifier, "dense"),
                (VolumeRole::SupportBlocker, "no support"),
                (VolumeRole::SupportEnforcer, "part 5"),
            ]
        );
        assert_eq!(
            mesh.volumes[1].settings,
            serde_json::json!({ "sparse_infill_density": "80%" })
        );
        assert!(mesh.volumes[0].settings.is_null());
        // A modifier above the top, a cut sticking out and a volume under the bed move nothing: the object is
        // its printed part.
        assert_eq!(mesh.bounds(), Some(([0.0, 0.0, 0.0], [20.0, 20.0, 10.0])));
        assert!(mesh.notes.is_empty(), "{:?}", mesh.notes);
        assert!(mesh.part_settings.is_empty());
        // On a plate they are the object's volumes, in the object's space.
        let plate = crate::plate::Plate::single(mesh);
        let o = &plate.objects[0];
        assert_eq!(o.volumes.len(), 4);
        assert!(o.volumes.iter().all(|v| v.transform.is_none()));
    }

    #[test]
    fn a_negative_part_listed_first_is_still_a_cut() {
        let settings = r#"<config><object id="10"><part id="1" subtype="negative_part"/><part id="2" subtype="normal_part"/></object></config>"#;
        let bytes = project(&[([5.0, 5.0, -1.0], [15.0, 15.0, 11.0]), BODY], settings);
        let mesh = Mesh::load(&bytes, "first.3mf").unwrap();
        assert_eq!(mesh.parts.len(), 1);
        assert_eq!(mesh.volumes.len(), 1);
        assert_eq!(mesh.volumes[0].role, VolumeRole::Negative);
    }

    #[test]
    fn unknown_part_types_print_and_are_named() {
        let settings = r#"<config><object id="10">
<part id="1" subtype="banana_part"><metadata key="name" value="odd"/><metadata key="not_a_real_key" value="1"/></part>
<part id="2" subtype=""/>
</object></config>"#;
        let bytes = project(&[BODY, ([30.0, 0.0, 0.0], [40.0, 10.0, 10.0])], settings);
        let mesh = Mesh::load(&bytes, "odd.3mf").unwrap();
        assert_eq!(mesh.parts.len(), 2, "an unknown or empty type prints");
        assert!(mesh.volumes.is_empty());
        assert!(
            mesh.notes
                .iter()
                .any(|n| n.contains("odd") && n.contains("banana_part")),
            "{:?}",
            mesh.notes
        );
        assert!(
            mesh.notes.iter().any(|n| n.contains("not_a_real_key")),
            "{:?}",
            mesh.notes
        );
    }

    #[test]
    fn part_type_metadata_replaces_the_subtype() {
        for key in ["volume_type", "part_type"] {
            let settings = format!(
                r#"<config><object id="10"><part id="1" subtype="normal_part"/><part id="2" subtype="normal_part"><metadata key="{key}" value="support_blocker"/></part></object></config>"#
            );
            let bytes = project(&[BODY, ([0.0, 0.0, 10.0], [20.0, 20.0, 12.0])], &settings);
            let mesh = Mesh::load(&bytes, "legacy.3mf").unwrap();
            assert_eq!(mesh.parts.len(), 1, "{key}");
            assert_eq!(mesh.volumes[0].role, VolumeRole::SupportBlocker, "{key}");
        }
    }

    #[test]
    fn object_settings_go_under_part_settings() {
        // Two printed parts with the same name: the one with settings of its own gets its id in its name.
        let settings = r#"<config><object id="10"><metadata key="name" value="obj"/><metadata key="extruder" value="1"/><metadata key="wall_loops" value="2"/><metadata key="sparse_infill_density" value="20%"/>
<part id="1" subtype="normal_part"><metadata key="wall_loops" value="3"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/><metadata key="source_object_id" value="0"/></part>
<part id="2" subtype="normal_part"/>
<part id="3" subtype="modifier_part"><metadata key="wall_loops" value="6"/></part>
</object></config>"#;
        let bytes = project(
            &[
                BODY,
                ([30.0, 0.0, 0.0], [40.0, 10.0, 10.0]),
                ([0.0, 0.0, 5.0], [20.0, 20.0, 10.0]),
            ],
            settings,
        );
        let mesh = Mesh::load(&bytes, "ladder.3mf").unwrap();
        assert_eq!(mesh.parts.len(), 2);
        // Both printed parts carry the object's settings; the first its own wall count over them.
        assert_eq!(mesh.part_settings.len(), 2);
        let first = &mesh.part_settings[0];
        assert_eq!(first.0, mesh.parts[0].name);
        assert_ne!(
            mesh.parts[0].name, mesh.parts[1].name,
            "settings go by name, so the names differ"
        );
        assert_eq!(
            first.1,
            serde_json::json!({ "wall_loops": "3", "sparse_infill_density": "20%" })
        );
        assert_eq!(
            mesh.part_settings[1].1,
            serde_json::json!({ "wall_loops": "2", "sparse_infill_density": "20%" })
        );
        // The modifier keeps the object's settings under its own.
        assert_eq!(
            mesh.volumes[0].settings,
            serde_json::json!({ "wall_loops": "6", "sparse_infill_density": "20%" })
        );
    }

    #[test]
    fn an_older_project_splits_its_mesh_by_triangle_ranges() {
        // One mesh object of two boxes (12 triangles each), the second a negative part.
        let a = box_object(1, [0.0, 0.0, 0.0], [20.0, 20.0, 10.0]);
        let b = box_object(1, [5.0, 5.0, -1.0], [15.0, 15.0, 11.0]);
        let verts =
            |s: &str| s[s.find("<vertices>").unwrap() + 10..s.find("</vertices>").unwrap()].to_owned();
        let tris = |s: &str, off: u32| -> String {
            use std::fmt::Write as _;
            let body = &s[s.find("<triangles>").unwrap() + 11..s.find("</triangles>").unwrap()];
            body.split("/>")
                .filter(|t| t.contains("v1"))
                .fold(String::new(), |mut acc, t| {
                    let n: Vec<u32> = t.split('"').filter_map(|x| x.parse().ok()).collect();
                    let _ = write!(
                        acc,
                        r#"<triangle v1="{}" v2="{}" v3="{}"/>"#,
                        n[0] + off,
                        n[1] + off,
                        n[2] + off
                    );
                    acc
                })
        };
        let model = format!(
            r#"<model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>{}{}</vertices><triangles>{}{}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#,
            verts(&a),
            verts(&b),
            tris(&a, 0),
            tris(&b, 8)
        );
        let settings = r#"<config><object id="1"><metadata key="name" value="old"/>
<volume firstid="0" lastid="11"><metadata key="name" value="body"/><metadata key="extruder" value="2"/></volume>
<volume firstid="12" lastid="23"><metadata key="name" value="hole"/><metadata key="volume_type" value="negative_part"/></volume>
</object></config>"#;
        let bytes = zip(&[
            ("3D/3dmodel.model", model.as_bytes(), true),
            ("Metadata/model_settings.config", settings.as_bytes(), false),
        ]);
        let mesh = Mesh::load(&bytes, "old.3mf").unwrap();
        assert_eq!(mesh.parts.len(), 1);
        assert_eq!(mesh.parts[0].name, "body");
        assert_eq!(mesh.parts[0].slot, 2);
        assert_eq!(mesh.parts[0].triangles.len(), 12);
        assert_eq!(mesh.volumes.len(), 1);
        assert_eq!(mesh.volumes[0].role, VolumeRole::Negative);
        assert_eq!(mesh.volumes[0].part.triangles.len(), 12);
        assert_eq!(mesh.bounds(), Some(([0.0, 0.0, 0.0], [20.0, 20.0, 10.0])));
    }

    #[test]
    fn each_plate_keeps_its_own_part_types() {
        // Objects 10 and 20 on plates 1 and 2, each a body with a negative part; their part ids repeat.
        let sub = format!(
            r#"<model unit="millimeter"><resources>{}{}</resources></model>"#,
            box_object(1, [0.0, 0.0, 0.0], [20.0, 20.0, 10.0]),
            box_object(2, [5.0, 5.0, -1.0], [15.0, 15.0, 11.0])
        );
        let comp = |id: u32| {
            format!(
                r#"<component p:path="/3D/Objects/object_1.model" objectid="{id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>"#
            )
        };
        let main = format!(
            r#"<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
<object id="10" type="model"><components>{a}{b}</components></object>
<object id="20" type="model"><components>{a}{b}</components></object>
</resources><build><item objectid="10"/><item objectid="20" transform="1 0 0 0 1 0 0 0 1 300 0 0"/></build></model>"#,
            a = comp(1),
            b = comp(2)
        );
        let settings = r#"<config>
<object id="10"><part id="1" subtype="normal_part"/><part id="2" subtype="negative_part"/></object>
<object id="20"><part id="1" subtype="normal_part"/><part id="2" subtype="modifier_part"><metadata key="wall_loops" value="5"/></part></object>
<plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="10"/></model_instance></plate>
<plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="20"/></model_instance></plate>
</config>"#;
        let bytes = zip(&[
            ("3D/3dmodel.model", main.as_bytes(), true),
            ("3D/Objects/object_1.model", sub.as_bytes(), true),
            ("Metadata/model_settings.config", settings.as_bytes(), false),
        ]);
        let plates = load_plates(&bytes, "two.3mf").unwrap();
        assert_eq!(plates.len(), 2);
        let (first_plate, first) = &plates[0];
        let (second_plate, second) = &plates[1];
        assert_eq!((*first_plate, *second_plate), (1, 2));
        assert_eq!(first.volumes.len(), 1);
        assert_eq!(first.volumes[0].role, VolumeRole::Negative);
        assert_eq!(second.volumes.len(), 1);
        assert_eq!(second.volumes[0].role, VolumeRole::Modifier);
        assert_eq!(
            second.volumes[0].settings,
            serde_json::json!({ "wall_loops": "5" })
        );
        // Plate 2's volume sits with its object, 300 mm along.
        let x0 = second.volumes[0]
            .part
            .positions
            .iter()
            .map(|p| p[0])
            .fold(f32::MAX, f32::min);
        assert!((x0 - 305.0).abs() < 1e-3, "{x0}");
        // One build item per mesh keeps its volumes too.
        let items = load_plate_objects(&bytes, "two.3mf").unwrap();
        assert_eq!(items[1].1[0].volumes.len(), 1);
    }

    #[test]
    fn volumes_and_part_settings_are_part_of_the_content_hash() {
        let plain = r#"<config><object id="10"><part id="1" subtype="normal_part"/><part id="2" subtype="normal_part"/></object></config>"#;
        let cut = r#"<config><object id="10"><part id="1" subtype="normal_part"/><part id="2" subtype="negative_part"/></object></config>"#;
        let boxes = [BODY, ([5.0, 5.0, -1.0], [15.0, 15.0, 11.0])];
        let a = Mesh::load(&project(&boxes, plain), "a.3mf").unwrap();
        let b = Mesh::load(&project(&boxes, cut), "b.3mf").unwrap();
        assert_ne!(a.content_hash(), b.content_hash());
        // Without volumes or settings the hash is the parts' alone, as before.
        let parts_only = Mesh {
            name: a.name.clone(),
            parts: a.parts.clone(),
            ..Mesh::default()
        };
        assert_eq!(a.content_hash(), parts_only.content_hash());
    }

    #[test]
    fn a_raw_copy_keeps_volumes_part_settings_and_notes() {
        // The web build hands later workers a raw copy of a loaded mesh; a copy without its volumes would print
        // the cut solid and drop the modifier in that worker's layers.
        let settings = r#"<config><object id="10"><metadata key="wall_loops" value="3"/>
<part id="1" subtype="normal_part"/>
<part id="2" subtype="negative_part"><metadata key="name" value="hole"/></part>
<part id="3" subtype="modifier_part"><metadata key="sparse_infill_density" value="80%"/></part>
<part id="4" subtype="banana_part"/>
</object></config>"#;
        let mesh = Mesh::load(
            &project(
                &[
                    BODY,
                    ([5.0, 5.0, -1.0], [15.0, 15.0, 11.0]),
                    ([0.0, 0.0, 0.0], [10.0, 20.0, 10.0]),
                    ([30.0, 0.0, 0.0], [40.0, 10.0, 10.0]),
                ],
                settings,
            ),
            "raw.3mf",
        )
        .unwrap();
        assert_eq!(mesh.volumes.len(), 2);
        assert!(!mesh.part_settings.is_empty() && !mesh.notes.is_empty());
        let copy = Mesh::load(&mesh.to_raw(), "raw.3mf").unwrap();
        assert_eq!(copy.content_hash(), mesh.content_hash());
        assert_eq!(copy.volumes.len(), 2);
        assert_eq!(copy.volumes[0].role, VolumeRole::Negative);
        assert_eq!(copy.volumes[0].part.name, "hole");
        assert_eq!(copy.volumes[0].part.positions, mesh.volumes[0].part.positions);
        assert_eq!(copy.volumes[1].settings, mesh.volumes[1].settings);
        assert_eq!(copy.part_settings, mesh.part_settings);
        assert_eq!(copy.notes, mesh.notes);
        assert_eq!(mesh.settings, serde_json::json!({ "wall_loops": "3" }));
        assert_eq!(copy.settings, mesh.settings);
        // A mesh with none of them writes no block.
        let bare = Mesh {
            name: mesh.name.clone(),
            parts: mesh.parts.clone(),
            ..Mesh::default()
        };
        assert!(!bare.to_raw().windows(4).any(|w| w == b"SXVL"));
    }

    #[test]
    fn metadata_values_are_unescaped() {
        assert_eq!(
            unescape("a &amp; b &lt;c&gt; &quot;d&quot; &#65;&#x42;"),
            "a & b <c> \"d\" AB"
        );
        assert_eq!(unescape("no entities"), "no entities");
        assert_eq!(unescape("broken &amp"), "broken &amp");
    }

    const CUBE_OBJECT: &str = r#"<object id="2" name="cube" type="model"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="10" y="10" z="0"/><vertex x="0" y="10" z="0"/>
<vertex x="0" y="0" z="10"/><vertex x="10" y="0" z="10"/><vertex x="10" y="10" z="10"/><vertex x="0" y="10" z="10"/>
</vertices><triangles>
<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
<triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
<triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
</triangles></mesh></object>"#;

    /// The raw parts format with a paint block: one part, slot `slot`, the cube's corners and triangles, and
    /// `(layer, triangle, text)` paint.
    fn raw_painted_cube(slot: u8, paint: &[(u8, u32, &str)]) -> Vec<u8> {
        let corners: [[f32; 3]; 8] = [
            [0., 0., 0.],
            [10., 0., 0.],
            [10., 10., 0.],
            [0., 10., 0.],
            [0., 0., 10.],
            [10., 0., 10.],
            [10., 10., 10.],
            [0., 10., 10.],
        ];
        let tris: [[u32; 3]; 12] = [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        let mut b = b"SXMP".to_vec();
        b.extend_from_slice(&1u32.to_le_bytes());
        b.push(slot);
        b.extend_from_slice(&4u16.to_le_bytes());
        b.extend_from_slice(b"cube");
        b.extend_from_slice(&8u32.to_le_bytes());
        for c in corners.iter().flatten() {
            b.extend_from_slice(&c.to_le_bytes());
        }
        b.extend_from_slice(&12u32.to_le_bytes());
        for i in tris.iter().flatten() {
            b.extend_from_slice(&i.to_le_bytes());
        }
        let layers: Vec<u8> = (0..4).filter(|l| paint.iter().any(|p| p.0 == *l)).collect();
        b.extend_from_slice(b"SXPT");
        b.extend_from_slice(&(layers.len() as u32).to_le_bytes());
        for l in layers {
            let list: Vec<_> = paint.iter().filter(|p| p.0 == l).collect();
            b.extend_from_slice(&0u32.to_le_bytes());
            b.push(l);
            b.extend_from_slice(&(list.len() as u32).to_le_bytes());
            for (_, t, text) in list {
                b.extend_from_slice(&t.to_le_bytes());
                b.extend_from_slice(&(text.len() as u16).to_le_bytes());
                b.extend_from_slice(text.as_bytes());
            }
        }
        b
    }

    #[test]
    fn raw_paint_loads_as_the_same_3mf_paint() {
        use std::fmt::Write as _;
        // Real paint texts from a painted keychain, a whole triangle in each of two filaments, and seam, support and
        // fuzzy skin paint: the painted pieces must come out the same either way, the part's own filament left out.
        let paint: &[(u8, u32, &str)] = &[
            (0, 0, "4"),
            (0, 2, "8"),
            (0, 5, "004044244640446400AA603"),
            (0, 8, "0044244244434404424464340446400A6440446400A2044244A33"),
            (1, 3, "4"),
            (2, 4, "8"),
            (2, 9, "04044244640446400AA6044244244A2"),
            (3, 6, "4"),
        ];
        let attr =
            |l: u8| ["paint_color", "paint_seam", "paint_supports", "paint_fuzzy_skin"][usize::from(l)];
        // The cube with each triangle's paint attributes, as the app's project writer puts them.
        let mut pieces = CUBE_OBJECT.split("<triangle ");
        let mut obj = pieces.next().unwrap_or_default().to_owned();
        for (i, rest) in pieces.enumerate() {
            obj.push_str("<triangle ");
            for (l, t, text) in paint {
                if *t as usize == i {
                    let _ = write!(obj, r#"{}="{text}" "#, attr(*l));
                }
            }
            obj.push_str(rest);
        }
        let model = format!(
            r#"<model unit="millimeter"><resources>{obj}</resources><build><item objectid="2"/></build></model>"#
        );
        let settings = r#"<config><object id="2"><metadata key="extruder" value="2"/></object></config>"#;
        let three = Mesh::load(
            &zip(&[
                ("3D/3dmodel.model", model.as_bytes(), true),
                ("Metadata/model_settings.config", settings.as_bytes(), false),
            ]),
            "cube.3mf",
        )
        .unwrap();
        let raw = Mesh::load(&raw_painted_cube(2, paint), "cube").unwrap();
        let (a, b) = (&three.parts[0], &raw.parts[0]);
        assert_eq!(a.slot, 2);
        assert_eq!(b.slot, 2);
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.triangles, b.triangles);
        assert!(
            !b.paint.is_empty()
                && !b.seam_paint.is_empty()
                && !b.support_paint.is_empty()
                && !b.fuzzy_paint.is_empty()
        );
        assert!(
            b.paint.iter().all(|f| f.state != 2),
            "the part's own filament is left out"
        );
        assert_eq!(a.paint, b.paint);
        assert_eq!(a.seam_paint, b.seam_paint);
        assert_eq!(a.support_paint, b.support_paint);
        assert_eq!(a.fuzzy_paint, b.fuzzy_paint);
        // A paint block cut short is refused, not read as garbage.
        let bytes = raw_painted_cube(2, paint);
        assert!(Mesh::from_raw(&bytes[..bytes.len() - 3], "cube").is_err());
    }

    #[test]
    fn plain_3mf_with_transform() {
        let model = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>{CUBE_OBJECT}</resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 50 0"/></build></model>"#
        );
        let bytes = zip(&[("3D/3dmodel.model", model.as_bytes(), true)]);
        let mesh = Mesh::load(&bytes, "cube.3mf").unwrap();
        assert_eq!(mesh.parts.len(), 1);
        assert_eq!(mesh.triangle_count(), 12);
        let (lo, hi) = mesh.bounds().unwrap();
        assert_eq!(lo, [100.0, 50.0, 0.0]);
        assert_eq!(hi, [110.0, 60.0, 10.0]);
    }

    #[test]
    fn production_components_and_slots() {
        let sub = format!(r#"<model unit="millimeter"><resources>{CUBE_OBJECT}</resources></model>"#);
        let main = r#"<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
<object id="5" type="model"><components>
<component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
<component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>
</components></object></resources><build><item objectid="5"/></build></model>"#;
        let rels = r#"<Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>"#;
        let settings = r#"<config><object id="5"><metadata key="extruder" value="3"/><part id="2" subtype="normal_part"><metadata key="extruder" value="2"/></part></object></config>"#;
        let bytes = zip(&[
            ("_rels/.rels", rels.as_bytes(), false),
            ("3D/3dmodel.model", main.as_bytes(), true),
            ("3D/Objects/object_1.model", sub.as_bytes(), true),
            ("Metadata/model_settings.config", settings.as_bytes(), false),
        ]);
        let mesh = Mesh::load(&bytes, "plate.3mf").unwrap();
        assert_eq!(mesh.parts.len(), 2);
        assert_eq!(mesh.parts[0].slot, 2);
        let (lo, hi) = mesh.bounds().unwrap();
        assert_eq!(lo[0], 0.0);
        assert_eq!(hi[0], 30.0);
    }

    #[test]
    fn components_that_repeat_a_mesh_without_end_are_refused() {
        use std::fmt::Write as _;
        // Each level holds the level below four times: 4^15 cubes from a file under 2 KB.
        let mut objects = CUBE_OBJECT.to_owned();
        for id in 3..18 {
            let parts = format!(
                r#"<component objectid="{}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>"#,
                id - 1
            )
            .repeat(4);
            let _ = write!(
                objects,
                r#"<object id="{id}" type="model"><components>{parts}</components></object>"#
            );
        }
        let model = format!(
            r#"<model unit="millimeter"><resources>{objects}</resources><build><item objectid="17"/></build></model>"#
        );
        let bytes = zip(&[("3D/3dmodel.model", model.as_bytes(), true)]);
        let t = std::time::Instant::now();
        let err = Mesh::load(&bytes, "bomb.3mf").unwrap_err().to_string();
        assert!(err.contains("too many"), "{err}");
        assert!(t.elapsed().as_secs() < 2);
        // Empty objects repeated the same way cost time without memory, and are refused too.
        let empty = model.replace(
            CUBE_OBJECT,
            r#"<object id="2" type="model"><mesh><vertices/><triangles/></mesh></object>"#,
        );
        let bytes = zip(&[("3D/3dmodel.model", empty.as_bytes(), true)]);
        assert!(Mesh::load(&bytes, "bomb.3mf").is_err());
        assert!(t.elapsed().as_secs() < 10);
    }

    #[test]
    fn bambu_plates() {
        let model = format!(
            r#"<model unit="millimeter"><resources>{CUBE_OBJECT}<object id="3" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 300 0 0"/></components></object></resources><build><item objectid="2"/><item objectid="3"/></build></model>"#
        );
        let settings = r#"<config><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate><plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="3"/></model_instance></plate></config>"#;
        let bytes = zip(&[
            ("3D/3dmodel.model", model.as_bytes(), true),
            ("Metadata/model_settings.config", settings.as_bytes(), false),
        ]);
        let plates = load_plates(&bytes, "p.3mf").unwrap();
        assert_eq!(plates.len(), 2);
        assert_eq!(plates[1].0, 2);
        assert_eq!(plates[1].1.bounds().unwrap().0[0], 300.0);
        assert_eq!(Mesh::load(&bytes, "p.3mf").unwrap().parts.len(), 1);
    }

    #[test]
    fn plate_objects_keep_each_build_item() {
        let model = format!(
            r#"<model unit="millimeter"><resources>{CUBE_OBJECT}<object id="3" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 60 0 0"/></components></object></resources><build><item objectid="2"/><item objectid="3"/></build></model>"#
        );
        let settings = r#"<config><object id="3"><metadata key="name" value="right"/><part id="2"><metadata key="name" value="a part"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance><model_instance><metadata key="object_id" value="3"/></model_instance></plate></config>"#;
        let bytes = zip(&[
            ("3D/3dmodel.model", model.as_bytes(), true),
            ("Metadata/model_settings.config", settings.as_bytes(), false),
        ]);
        let plates = load_plate_objects(&bytes, "p.3mf").unwrap();
        assert_eq!(plates.len(), 1);
        let items = &plates[0].1;
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "cube");
        assert_eq!(items[1].name, "right");
        assert_eq!(items[1].bounds().unwrap().0[0], 60.0);
        // the merged plate is still one mesh with both
        assert_eq!(load_plates(&bytes, "p.3mf").unwrap()[0].1.parts.len(), 2);
    }

    #[test]
    fn project_metadata() {
        let model = format!(
            r#"<model unit="millimeter"><resources>{CUBE_OBJECT}</resources><build><item objectid="2"/></build></model>"#
        );
        let bytes = zip(&[
            ("3D/3dmodel.model", model.as_bytes(), true),
            (
                "Metadata/project_settings.config",
                br#"{"layer_height":"0.2","nozzle_diameter":["0.4"]}"#,
                true,
            ),
            ("Metadata/model_settings.config", b"<config/>", false),
        ]);
        let m = metadata(&bytes, "p.3mf").unwrap();
        assert_eq!(m.project_settings.as_ref().unwrap()["layer_height"], "0.2");
        assert_eq!(m.model_settings.as_deref(), Some("<config/>"));
        assert!(m.layer_ranges.is_none());
        let json = serde_json::to_value(&m).unwrap();
        assert!(json.get("projectSettings").is_some() && json.get("layerRanges").is_none());
        let plain = zip(&[("3D/3dmodel.model", model.as_bytes(), true)]);
        assert_eq!(metadata(&plain, "p.3mf").unwrap(), ProjectMetadata::default());
        let bad = zip(&[("Metadata/project_settings.config", b"nope", false)]);
        assert!(metadata(&bad, "p.3mf").is_err());
        assert!(metadata(b"not a zip at all, sorry", "p.3mf").is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(Mesh::load(b"PK\x03\x04 not really", "x.3mf").is_err());
        assert!(Mesh::load(&zip(&[("3D/3dmodel.model", b"<model/>", false)]), "x.3mf").is_err());
    }

    /// A 1 inch cube in `unit`, its side `side` long in that unit, with the top painted for filament 2 and a side
    /// painted for support: the same cube as a file in millimeters with a side of 25.4.
    fn painted_cube(unit: &str, side: f32) -> Vec<u8> {
        let v = |x: u8, y: u8, z: u8| {
            format!(
                r#"<vertex x="{}" y="{}" z="{}"/>"#,
                f32::from(x) * side,
                f32::from(y) * side,
                f32::from(z) * side
            )
        };
        let verts = [
            v(0, 0, 0),
            v(1, 0, 0),
            v(1, 1, 0),
            v(0, 1, 0),
            v(0, 0, 1),
            v(1, 0, 1),
            v(1, 1, 1),
            v(0, 1, 1),
        ]
        .concat();
        let model = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><model unit="{unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="2" name="cube" type="model"><mesh><vertices>{verts}</vertices><triangles>
<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6" paint_color="8"/><triangle v1="4" v2="6" v3="7" paint_color="8"/>
<triangle v1="0" v2="1" v3="5" paint_supports="4"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
<triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
</triangles></mesh></object></resources><build><item objectid="2"/></build></model>"#
        );
        zip(&[("3D/3dmodel.model", model.as_bytes(), true)])
    }

    #[test]
    fn an_inch_file_scales_its_paint_with_its_positions() {
        let inch = Mesh::load(&painted_cube("inch", 1.0), "inch.3mf").unwrap();
        let mm = Mesh::load(&painted_cube("millimeter", 25.4), "mm.3mf").unwrap();
        let (a, b) = (&inch.parts[0], &mm.parts[0]);
        let close = |p: &[f32; 3], q: &[f32; 3]| p.iter().zip(q).all(|(x, y)| (x - y).abs() < 1e-4);
        let moved = |p: &[f32; 3]| *p;
        assert_eq!(a.positions.len(), b.positions.len());
        assert!(
            a.positions
                .iter()
                .zip(&b.positions)
                .all(|(p, q)| close(&moved(p), q))
        );
        for (fa, fb) in [(&a.paint, &b.paint), (&a.support_paint, &b.support_paint)] {
            assert!(!fa.is_empty() && fa.len() == fb.len());
            for (x, y) in fa.iter().zip(fb.iter()) {
                assert_eq!(x.state, y.state);
                assert!(
                    x.v.iter().zip(&y.v).all(|(p, q)| close(&moved(p), q)),
                    "{:?} {:?}",
                    x.v,
                    y.v
                );
            }
        }
        // The top is painted at the cube's top, 25.4 mm up, not at 1.
        assert!(
            a.paint
                .iter()
                .all(|f| f.v.iter().all(|p| (p[2] - 25.4).abs() < 1e-4))
        );
    }

    #[test]
    fn an_inch_file_slices_as_its_millimeter_twin_in_one_shard_or_four() {
        // Two filaments: the painted top prints with filament 2.
        let slice = |bytes: Vec<u8>, shards: u32| {
            let mesh = std::sync::Arc::new(Mesh::load(&bytes, "cube.3mf").unwrap());
            let req: crate::api::SliceRequest = serde_json::from_value(serde_json::json!({
                "plate": {"objects": [{"mesh": "c"}]},
                "config": {"nozzle_temperature": [220, 220], "filament_diameter": [1.75, 1.75], "brim_type": "no_brim"},
                "options": {"shards": shards},
            }))
            .unwrap();
            let run = crate::api::run_request(&req, &move |_: &str| Ok(mesh.clone())).unwrap();
            String::from_utf8(run.gcode).unwrap()
        };
        let mm = slice(painted_cube("millimeter", 25.4), 1);
        assert!(
            mm.contains(
                "
T1
"
            ),
            "the painted top prints with filament 2"
        );
        assert_eq!(slice(painted_cube("inch", 1.0), 1), mm);
        assert_eq!(slice(painted_cube("inch", 1.0), 4), mm);
    }

    /// The cube file with `head` as the model tag and `edit` applied to the rest.
    fn cube_file(head: &str, edit: &dyn Fn(String) -> String) -> std::result::Result<Mesh, String> {
        let body = edit(format!(
            r#"<resources>{CUBE_OBJECT}</resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 50 0"/></build></model>"#
        ));
        let model = format!(r#"<?xml version="1.0" encoding="UTF-8"?>{head}{body}"#);
        Mesh::load(&zip(&[("3D/3dmodel.model", model.as_bytes(), true)]), "cube.3mf")
            .map_err(|e| e.to_string())
    }

    const CORE: &str =
        r#"<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">"#;

    #[test]
    fn a_malformed_3mf_is_refused_with_what_and_where() {
        let same = |s: String| s;
        assert_eq!(cube_file(CORE, &same).unwrap().triangle_count(), 12);
        let refused = |head: &str, edit: &dyn Fn(String) -> String, says: &str| {
            let e = cube_file(head, edit).unwrap_err();
            assert!(e.contains(says), "{e}");
        };
        refused(
            r#"<model unit="furlong">"#,
            &same,
            "3D/3dmodel.model: refused unit 0 0 furlong",
        );
        refused(
            r#"<model unit="millimeter" xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02" requiredextensions="b">"#,
            &same,
            "refused extension 0 0 http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02",
        );
        refused(
            CORE,
            &|s| s.replacen(r#"x="10""#, r#"x="ten""#, 1),
            "refused vertex 2 1 ten",
        );
        refused(
            CORE,
            &|s| s.replacen(r#"x="10""#, r#"x="NaN""#, 1),
            "refused vertex 2 1 NaN",
        );
        refused(
            CORE,
            &|s| s.replacen(r#"v3="1""#, r#"v3="8""#, 1),
            "refused index 2 0 8",
        );
        refused(
            CORE,
            &|s| s.replacen(r#"v3="1""#, r#"v3="-1""#, 1),
            "refused triangle 2 0 -1",
        );
        refused(
            CORE,
            &|s| s.replace("1 0 0 0 1 0 0 0 1 100 50 0", "1 0 0 0 1 0 0 0 1 100 50"),
            "refused transform 0 0 1 0 0 0 1 0 0 0 1 100 50",
        );
        refused(
            CORE,
            &|s| s.replace("100 50 0", "100 fifty 0"),
            "refused transform 0 0 1 0 0 0 1 0 0 0 1 100 fifty 0",
        );
        refused(
            CORE,
            &|s| s.replace(r#"<item objectid="2""#, r#"<item objectid="two""#),
            "refused id 0 0 two",
        );
    }

    #[test]
    fn extensions_the_loader_reads_or_may_leave_out_still_load() {
        let head = r#"<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02" requiredextensions="p m">"#;
        // beam lattice is declared but not required: it is left out
        assert_eq!(cube_file(head, &|s| s).unwrap().triangle_count(), 12);
        for unit in ["micron", "millimeter", "centimeter", "inch", "foot", "meter"] {
            let head = format!(r#"<model unit="{unit}">"#);
            assert!(cube_file(&head, &|s| s).is_ok(), "{unit}");
        }
    }

    #[test]
    fn the_bench_projects_load_as_before() {
        for (file, parts) in [("x-mark-2color.3mf", 2), ("x-mark-2color-orca.3mf", 2)] {
            let bytes = std::fs::read(format!("{}/bench/models/{file}", env!("CARGO_MANIFEST_DIR"))).unwrap();
            let mesh = Mesh::load(&bytes, file).unwrap();
            assert_eq!(mesh.parts.len(), parts, "{file}");
        }
    }
}
